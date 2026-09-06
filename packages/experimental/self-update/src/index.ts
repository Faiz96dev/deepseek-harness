/**
 * Host Remote service that fetches the configured upstream branch, resets
 * this checkout onto it, restores this deployment's own overlay paths,
 * rebuilds, and restarts — while leaving every durable Session untouched.
 * @module @deepseek-ai/dsh-experimental-self-update
 */

import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.sessions Context merge into this compilation face.
import type {} from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { Config } from './config.ts'
import type { Config as SelfUpdateConfig } from './config.ts'
import { SelfUpdateGit } from './git.ts'
import { isTerminal, SelfUpdateJob } from './job.ts'
import type {
  SelfUpdateCommit,
  SelfUpdateFollowFrame,
  SelfUpdateJobSnapshot,
  SelfUpdateStartResult,
  SelfUpdateStatusValue,
} from './types.ts'

export type { Config } from './config.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host self-update business API and Remote namespace owner. */
    selfUpdate: SelfUpdateService
  }
}

function success<T>(value: T): { ok: true; value: T } {
  return Object.freeze({ ok: true, value })
}

function rejected<E>(error: E): { ok: false; error: E } {
  return Object.freeze({ ok: false, error })
}

/**
 * Read the checked-out release version: `version` of `<repoRoot>/package.json`.
 * `repoRoot` is required to be a harness checkout, so a missing file or a
 * non-string `version` is a misconfiguration and fails loud rather than
 * reporting an empty version.
 * @param repoRoot - the configured checkout root.
 * @returns the manifest's `version` string.
 */
async function readDeploymentVersion(repoRoot: string): Promise<string> {
  const manifestPath = join(repoRoot, 'package.json')
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const version = typeof manifest === 'object' && manifest !== null
    ? (manifest as { version?: unknown }).version
    : undefined
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`self-update: ${manifestPath} must declare a non-empty string "version"`)
  }
  return version
}

/** Host service backing the generated `ctx.remote.selfUpdate` namespace. */
export class SelfUpdateService extends TypertRemoteService {
  static inject = ['subprocess', 'sessions']

  static Config = Config

  private readonly git: SelfUpdateGit
  private job: SelfUpdateJob | undefined
  private lastRun: SelfUpdateJobSnapshot | undefined
  private lastRemoteHead: SelfUpdateCommit | undefined

  /**
   * Creates `config.logDir` so an uncreatable log directory fails the plugin
   * at load rather than the first update attempt.
   * @param ctx - Host context carrying the subprocess and session capabilities.
   * @param config - validated deployment policy.
   */
  constructor(ctx: Context, private readonly config: SelfUpdateConfig) {
    super(ctx, 'selfUpdate')
    mkdirSync(config.logDir, { recursive: true })
    this.git = new SelfUpdateGit(ctx, config)
  }

  /**
   * Read current repository and job state without fetching. `version` is
   * re-read from `<repoRoot>/package.json` on every call so it tracks the
   * checkout even while an update is rewriting it. `behind` and
   * `remoteHead` reflect the last `check` (or update attempt) this process
   * observed; they are `null` until one has run — this method never fetches
   * on its own, so repeated polling never contacts the remote.
   * @returns the current status snapshot.
   */
  @Remote('status')
  async status(): Promise<SelfUpdateStatusValue> {
    const version = await readDeploymentVersion(this.config.repoRoot)
    const head = await this.git.currentHead()
    const dirty = await this.git.isDirty()
    let ahead = 0
    let behind: number | null = null
    if (this.lastRemoteHead !== undefined) {
      const counts = await this.git.revCounts()
      ahead = counts.ahead
      behind = counts.behind
    }
    return Object.freeze({
      version,
      head,
      remoteHead: this.lastRemoteHead ?? null,
      behind,
      ahead,
      dirty,
      job: this.job?.snapshot ?? null,
      lastRun: this.lastRun ?? null,
    })
  }

  /**
   * Fetch the configured upstream branch, then report status against it.
   * @returns status reflecting the freshly fetched upstream head.
   */
  @Remote('check')
  async check(): Promise<SelfUpdateStatusValue> {
    await this.git.fetch(() => {})
    const counts = await this.git.revCounts()
    this.lastRemoteHead = counts.remoteHead
    return await this.status()
  }

  /**
   * Begin one update attempt. Refuses synchronously when a job is already
   * running, the working tree is dirty, or no bounded exit request is
   * available. Any Sessions currently attached to a live fiber are flushed
   * to disk first — an in-flight turn is interrupted, but recoverable on next
   * open per the Session repair contract — so a start never waits on, or
   * asks about, live Sessions.
   * @returns the started job's snapshot, or a stable business refusal.
   */
  @Remote('start')
  async start(): Promise<SelfUpdateStartResult> {
    if (this.job !== undefined && !isTerminal(this.job.snapshot)) {
      return this.refuse({ code: 'job-already-running' as const })
    }
    const appExit = this.ctx.get('appExit')
    if (appExit === undefined) return this.refuse({ code: 'app-exit-unavailable' as const })
    if (await this.git.isDirty()) return this.refuse({ code: 'dirty-working-tree' as const })

    await Promise.all(this.ctx.sessions.list().map(session => this.ctx.sessions.flush(session)))

    const job = SelfUpdateJob.start({ ctx: this.ctx, git: this.git, config: this.config, appExit })
    this.job = job
    void this.trackCompletion(job)
    return success(job.snapshot)
  }

  /** Refuse one start request, leaving the reason in the Host log where a silent-looking click can be explained. */
  private refuse(error: Extract<SelfUpdateStartResult, { ok: false }>['error']): SelfUpdateStartResult {
    this.ctx.logger.warn(`self-update: start refused: ${JSON.stringify(error)}`)
    return rejected(error)
  }

  private async trackCompletion(job: SelfUpdateJob): Promise<void> {
    await job.whenDone()
    this.lastRun = job.snapshot
  }

  /**
   * Follow the current (or most recently started) job: a baseline combining
   * live repository status with every retained log line, then phase/log/done
   * increments as they occur. Yields an idle baseline with no job when none
   * has ever run.
   * @param signal - ends this subscription when aborted.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<SelfUpdateFollowFrame> {
    const status = await this.status()
    const job = this.job
    yield { type: 'baseline', status, log: job?.retainedLog ?? [] }
    if (job === undefined) return
    yield* job.followIncrements(signal)
  }
}

export default SelfUpdateService
