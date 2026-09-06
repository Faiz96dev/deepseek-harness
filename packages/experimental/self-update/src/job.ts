/**
 * The update job state machine: one lifecycle controller per attempt, from
 * preflight through restart or a reported, recoverable failure.
 * @module @deepseek-ai/dsh-experimental-self-update/job
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AppExit } from '@deepseek-ai/dsh-cmdline'
import { createBackup } from './backup.ts'
import type { Config } from './config.ts'
import type { SelfUpdateGit } from './git.ts'
import { openJobLogFile } from './log.ts'
import type { JobLogFile } from './log.ts'
import { runStreaming } from './runner.ts'
import type {
  SelfUpdateCommit,
  SelfUpdateFailure,
  SelfUpdateFollowFrame,
  SelfUpdateJobId,
  SelfUpdateJobSnapshot,
  SelfUpdateLogLine,
  SelfUpdatePhase,
} from './types.ts'

/** Business error carrying one typed {@link SelfUpdateFailure}; never crosses a Remote boundary uncaught. */
export class SelfUpdateBusinessError extends Error {
  constructor(readonly failure: SelfUpdateFailure) {
    super(`self-update: ${failure.code}`)
  }
}

/** Dependencies one job needs; assembled by the owning service. */
export interface SelfUpdateJobDeps {
  readonly ctx: Context
  readonly git: SelfUpdateGit
  readonly config: Config
  readonly appExit: AppExit | undefined
}

type Waiter = () => void

/** Queue of frames for one `follow()` subscriber, mirroring `WorkspaceFollower`. */
class JobFollower {
  private readonly frames: SelfUpdateFollowFrame[] = []
  private waiting: Waiter | undefined
  private closed = false

  push(frame: SelfUpdateFollowFrame): void {
    // No current caller publishes after closing this follower (finish()
    // closes every follower only once, after its one and only publish); this
    // guards a future caller that might.
    /* v8 ignore next -- unreachable through today's single publish-then-close call order. */
    if (this.closed) return
    this.frames.push(frame)
    this.waiting?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<SelfUpdateFollowFrame> {
    while (!signal.aborted) {
      const frame = this.frames.shift()
      if (frame !== undefined) {
        yield frame
        continue
      }
      // Closing and the frames that precede it can both land in the same
      // synchronous burst (`finish`/`restart` publish, then close, before this
      // generator's suspended `wait` ever resumes); checking `closed` only
      // once the queue is actually empty guarantees every frame published
      // before close is still delivered.
      if (this.closed) return
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one read owns the sole installed wait callback. */
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      /* v8 ignore next -- native signals and the private queue cannot change during this synchronous setup. */
      if (signal.aborted || this.closed || this.frames.length > 0) finish()
    })
  }
}

/** `true` once a job has settled into a terminal phase-and-outcome pair. */
export function isTerminal(snapshot: SelfUpdateJobSnapshot): boolean {
  return snapshot.finishedAt !== null
}

/** One update attempt: preflight, fetch, backup, reset onto upstream, overlay, install, build, verify, commit, restart. */
export class SelfUpdateJob {
  private snapshotValue: SelfUpdateJobSnapshot
  private readonly log: SelfUpdateLogLine[] = []
  private readonly followers = new Set<JobFollower>()
  private readonly file: JobLogFile
  private readonly tag: string
  private runPromise!: Promise<void>

  private constructor(private readonly deps: SelfUpdateJobDeps) {
    const id = randomUUID() as SelfUpdateJobId
    const startedAt = Date.now()
    this.snapshotValue = Object.freeze({
      id,
      phase: 'preflight',
      startedAt,
      finishedAt: null,
      outcome: null,
      failure: null,
      fromCommit: null,
      toCommit: null,
      backupPath: null,
    })
    this.tag = `self-update [${id.slice(0, 8)}]`
    this.file = openJobLogFile(deps.config.logDir, id, startedAt, (error) => {
      deps.ctx.logger.warn(`${this.tag} log file ${this.file.path} unavailable, further lines are not written: ${error.message}`)
    })
    this.file.note(`job ${id} started`)
    deps.ctx.logger.info(`${this.tag} started; log file ${this.file.path}`)
  }

  /** Absolute path of this job's durable log file. */
  get logPath(): string {
    return this.file.path
  }

  /** Current job state; replaced, never mutated, on every transition. */
  get snapshot(): SelfUpdateJobSnapshot {
    return this.snapshotValue
  }

  /** Resolves once this job has settled into a terminal outcome; `run()` never rejects. */
  whenDone(): Promise<void> {
    return this.runPromise
  }

  /**
   * Construct a new job and begin running it in the background. The caller
   * observes progress and completion only through {@link snapshot} and
   * {@link follow}; this method never throws for a business failure — those
   * settle into the returned job's terminal snapshot instead.
   * @param deps - git operations, deployment config, and the bounded exit request.
   * @returns the running job.
   */
  static start(deps: SelfUpdateJobDeps): SelfUpdateJob {
    const job = new SelfUpdateJob(deps)
    job.runPromise = job.run()
    return job
  }

  /** Every log line retained so far, oldest first, bounded by `config.maxLogLines`. */
  get retainedLog(): readonly SelfUpdateLogLine[] {
    return this.log
  }

  /**
   * Subscribe to this job's own phase/log/done increments, from this moment
   * forward. The owning service composes the full baseline (repository status
   * plus {@link retainedLog}) before opening this subscription, so a fresh
   * subscriber never misses a frame between reading the baseline and joining
   * here.
   * @param signal - ends this subscription when aborted.
   */
  async *followIncrements(signal: AbortSignal): AsyncIterable<SelfUpdateFollowFrame> {
    signal.throwIfAborted()
    const follower = new JobFollower()
    this.followers.add(follower)
    try {
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  private publish(frame: SelfUpdateFollowFrame): void {
    for (const follower of this.followers) follower.push(frame)
  }

  private transition(patch: Partial<SelfUpdateJobSnapshot>): void {
    this.snapshotValue = Object.freeze({ ...this.snapshotValue, ...patch })
  }

  private enterPhase(phase: SelfUpdatePhase): void {
    this.transition({ phase })
    this.publish({ type: 'phase', phase })
    this.file.note(`phase ${phase}`)
    this.deps.ctx.logger.info(`${this.tag} phase ${phase}`)
  }

  private recordLine(line: SelfUpdateLogLine): void {
    this.log.push(line)
    if (this.log.length > this.deps.config.maxLogLines) this.log.shift()
    this.publish({ type: 'log', line })
    this.file.line(line)
  }

  private systemLine(phase: SelfUpdatePhase, text: string): void {
    this.recordLine({ seq: this.log.length, phase, stream: 'system', text, at: Date.now() })
  }

  private finish(outcome: SelfUpdateJobSnapshot['outcome'], failure: SelfUpdateFailure | null): void {
    this.transition({ finishedAt: Date.now(), outcome, failure })
    this.publish({ type: 'done', job: this.snapshotValue })
    for (const follower of this.followers) follower.close()
    this.recordOutcome()
  }

  /** Write the settled outcome to the log file and the Host logger. */
  private recordOutcome(): void {
    const { outcome, failure } = this.snapshotValue
    const summary = failure === null
      ? `outcome ${String(outcome)}`
      : `outcome ${String(outcome)} failure ${JSON.stringify(failure)}`
    this.file.note(summary)
    if (failure === null) this.deps.ctx.logger.info(`${this.tag} ${summary}`)
    else this.deps.ctx.logger.warn(`${this.tag} ${summary}`)
  }

  private async run(): Promise<void> {
    try {
      await this.preflight()
    } catch (error) {
      this.finish('failed', toFailure(error))
      return
    }

    const preUpdateHead = this.snapshotValue.fromCommit as SelfUpdateCommit

    try {
      this.enterPhase('fetching')
      let behind: number
      try {
        await this.deps.git.fetch((line) => { this.recordLine(line) })
        const counts = await this.deps.git.revCounts()
        this.transition({ toCommit: counts.remoteHead })
        behind = counts.behind
      } catch (error) {
        throw new SelfUpdateBusinessError({ code: 'fetch-failed', message: messageOf(error) })
      }
      if (behind === 0) {
        this.systemLine('fetching', 'already up to date with upstream')
        this.finish('up-to-date', null)
        return
      }

      this.enterPhase('backing-up')
      let backupPath: string
      try {
        backupPath = await createBackup(this.deps.config, preUpdateHead)
      } catch (error) {
        throw new SelfUpdateBusinessError({ code: 'backup-failed', message: messageOf(error) })
      }
      this.transition({ backupPath })
      this.systemLine('backing-up', `snapshot written to ${backupPath}`)

      this.enterPhase('resetting')
      const remoteHead = this.snapshotValue.toCommit as SelfUpdateCommit
      try {
        await this.deps.git.resetHard(remoteHead.sha, (line) => { this.recordLine(line) })
      } catch (error) {
        throw new SelfUpdateBusinessError({ code: 'reset-failed', message: messageOf(error) })
      }

      this.enterPhase('overlaying')
      try {
        await this.deps.git.restorePaths(this.deps.config.overlayRef, this.deps.config.overlayPaths, (line) => { this.recordLine(line) })
      } catch (error) {
        throw new SelfUpdateBusinessError({ code: 'overlay-failed', message: messageOf(error) })
      }

      try {
        await this.installBuildVerify()
        this.enterPhase('committing')
        try {
          await this.deps.git.commitAll(
            `self-update: overlay ${this.deps.config.overlayRef} onto ${remoteHead.sha.slice(0, 7)}`,
            (line) => { this.recordLine(line) },
          )
        } catch (error) {
          throw new SelfUpdateBusinessError({ code: 'commit-failed', message: messageOf(error) })
        }
      } catch (installBuildOrCommitError) {
        // The rollback's own failure is a distinct, more severe outcome than
        // the failure that triggered it, so it must not reach the outer catch
        // below and be reported as an ordinary `failed` job — it is handled
        // here, at the only place that knows which of the two actually happened.
        try {
          await this.rollback(preUpdateHead)
        } catch (rollbackError) {
          this.finish('rolled-back', toFailure(rollbackError))
          return
        }
        this.finish('rolled-back', toFailure(installBuildOrCommitError))
        return
      }

      this.enterPhase('restarting')
      this.restart()
    } catch (error) {
      this.finish('failed', toFailure(error))
    }
  }

  private async preflight(): Promise<void> {
    if (this.deps.appExit === undefined) throw new SelfUpdateBusinessError({ code: 'app-exit-unavailable' })
    if (await this.deps.git.isDirty()) throw new SelfUpdateBusinessError({ code: 'dirty-working-tree' })
    if (!await this.deps.git.refExists(this.deps.config.overlayRef)) {
      throw new SelfUpdateBusinessError({ code: 'overlay-ref-missing', ref: this.deps.config.overlayRef })
    }
    const head = await this.deps.git.currentHead()
    this.transition({ fromCommit: head })
  }

  private async installBuildVerify(): Promise<void> {
    this.enterPhase('installing')
    await this.runArgvOrThrow(this.deps.config.installArgv, 'installing', 'install-failed')
    this.enterPhase('building')
    await this.runArgvOrThrow(this.deps.config.buildArgv, 'building', 'build-failed')
    this.enterPhase('verifying')
    await this.runArgvOrThrow(this.deps.config.verifyArgv, 'verifying', 'verify-failed')
  }

  private async runArgvOrThrow(
    argv: readonly string[],
    phase: SelfUpdatePhase,
    code: 'install-failed' | 'build-failed' | 'verify-failed',
  ): Promise<void> {
    const outcome = await runStreaming(this.deps.ctx, this.deps.config, argv, phase, (line) => { this.recordLine(line) })
    if (outcome.exitCode !== 0) {
      throw new SelfUpdateBusinessError({ code, exitCode: outcome.exitCode, message: `${argv.join(' ')} exited ${String(outcome.exitCode)}` })
    }
  }

  private async rollback(preUpdateHead: SelfUpdateCommit): Promise<void> {
    this.systemLine(this.snapshotValue.phase, `rolling back to ${preUpdateHead.sha}`)
    try {
      await this.deps.git.resetHard(preUpdateHead.sha, (line) => { this.recordLine(line) })
      this.enterPhase('installing')
      await this.runArgvOrThrow(this.deps.config.installArgv, 'installing', 'install-failed')
      this.enterPhase('building')
      await this.runArgvOrThrow(this.deps.config.buildArgv, 'building', 'build-failed')
    } catch (error) {
      const message = messageOf(error)
      this.systemLine(this.snapshotValue.phase, `rollback failed: ${message}`)
      throw new SelfUpdateBusinessError({ code: 'rollback-failed', message })
    }
  }

  /** Preflight already required a resolvable exit request, so it is never undefined here. */
  private restart(): void {
    const exit = this.deps.appExit as NonNullable<SelfUpdateJobDeps['appExit']>
    this.transition({ finishedAt: Date.now(), outcome: 'succeeded', failure: null })
    this.publish({ type: 'done', job: this.snapshotValue })
    for (const follower of this.followers) follower.close()
    // Synchronous, so the outcome is on disk before the exit request below.
    this.recordOutcome()
    // Yield one microtask so the 'restarting' phase and 'done' frames reach
    // every open stream before the process exits.
    queueMicrotask(() => { exit(0) })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Every phase that can throw a bare (non-business) error wraps it into a
 * typed {@link SelfUpdateFailure} at its own call site; this is the
 * last-resort translation for a genuinely unexpected throw that reached here
 * unwrapped (a bug, not a modeled failure mode).
 */
function toFailure(error: unknown): SelfUpdateFailure {
  if (error instanceof SelfUpdateBusinessError) return error.failure
  return { code: 'unexpected', message: messageOf(error) }
}
