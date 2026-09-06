/**
 * Git operations this package issues against `config.repoRoot`, each built on
 * the shared streaming runner.
 * @module @deepseek-ai/dsh-experimental-self-update/git
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { runStreaming } from './runner.ts'
import type { SelfUpdateLogLine, SelfUpdatePhase, SelfUpdateCommit } from './types.ts'

/** One collected-output run: joins every emitted line so a caller can inspect the whole text. */
async function runCollecting(
  ctx: Context,
  config: Config,
  argv: readonly string[],
  phase: SelfUpdatePhase,
  onLine: (line: SelfUpdateLogLine) => void,
): Promise<{ exitCode: number | null; text: string }> {
  const lines: string[] = []
  const outcome = await runStreaming(ctx, config, argv, phase, (line) => {
    lines.push(line.text)
    onLine(line)
  })
  return { exitCode: outcome.exitCode, text: lines.join('\n') }
}

/** Repository operations this package performs; one instance per service. */
export class SelfUpdateGit {
  constructor(private readonly ctx: Context, private readonly config: Config) {}

  /**
   * Whether the working tree carries uncommitted changes.
   * Untracked files count as dirty: an update that reset over them would
   * silently discard unrelated local work.
   */
  async isDirty(): Promise<boolean> {
    const { text } = await runCollecting(this.ctx, this.config, ['git', 'status', '--porcelain'], 'preflight', () => {})
    return text.trim().length > 0
  }

  /** Current commit HEAD points at. */
  async currentHead(): Promise<SelfUpdateCommit> {
    const { text } = await runCollecting(
      this.ctx, this.config, ['git', 'log', '-1', '--format=%H%x1f%s'], 'preflight', () => {},
    )
    return parseCommitLine(text)
  }

  /**
   * Fetch the configured remote branch, streaming progress lines.
   * @param onLine - sink for fetch progress.
   */
  async fetch(onLine: (line: SelfUpdateLogLine) => void): Promise<void> {
    const lines: string[] = []
    const outcome = await runStreaming(
      this.ctx, this.config, ['git', 'fetch', this.config.remoteName, this.config.branch], 'fetching',
      (line) => { lines.push(line.text); onLine(line) },
    )
    if (outcome.exitCode !== 0) {
      // git's own diagnostic (a network timeout, a rate limit, DNS failure,
      // an unknown remote branch) is the actionable part; the exit code alone
      // does not distinguish any of those from each other.
      const detail = lines.length > 0 ? `: ${lines.join(' ')}` : ''
      throw new Error(`git fetch ${this.config.remoteName} ${this.config.branch} exited ${String(outcome.exitCode)}${detail}`)
    }
  }

  /** Commit counts between local HEAD and the last-fetched remote branch tip, and that tip itself. */
  async revCounts(): Promise<{ ahead: number; behind: number; remoteHead: SelfUpdateCommit }> {
    const remoteRef = `${this.config.remoteName}/${this.config.branch}`
    const remoteHeadResult = await runCollecting(
      this.ctx, this.config, ['git', 'log', '-1', '--format=%H%x1f%s', remoteRef], 'fetching', () => {},
    )
    if (remoteHeadResult.exitCode !== 0) {
      throw new Error(`git log -1 ${remoteRef} exited ${String(remoteHeadResult.exitCode)}`)
    }
    const countResult = await runCollecting(
      this.ctx, this.config,
      ['git', 'rev-list', '--left-right', '--count', `HEAD...${remoteRef}`],
      'fetching',
      () => {},
    )
    // Any ref `git log -1` above already accepted is also valid for
    // `rev-list`'s range syntax, so this only guards a local HEAD that
    // somehow stopped existing between the two calls.
    /* v8 ignore next 3 -- no real git state reaches `log -1 <ref>` success and `rev-list HEAD...<ref>` failure in the same call. */
    if (countResult.exitCode !== 0) {
      throw new Error(`git rev-list HEAD...${remoteRef} exited ${String(countResult.exitCode)}`)
    }
    // `git rev-list --left-right --count` always emits exactly "<ahead> <behind>".
    const [aheadText, behindText] = countResult.text.trim().split(/\s+/) as [string, string]
    return {
      ahead: Number.parseInt(aheadText, 10),
      behind: Number.parseInt(behindText, 10),
      remoteHead: parseCommitLine(remoteHeadResult.text),
    }
  }

  /**
   * Whether `ref` resolves to a real commit in this checkout.
   * @param ref - the git ref to check.
   */
  async refExists(ref: string): Promise<boolean> {
    const outcome = await runStreaming(
      this.ctx, this.config, ['git', 'rev-parse', '-q', '--verify', `${ref}^{commit}`], 'preflight', () => {},
    )
    return outcome.exitCode === 0
  }

  /**
   * Hard-reset the working tree to `sha`, discarding every commit and
   * uncommitted change since. Preflight already required a clean tree, and
   * every phase after this restores this deployment's own paths from
   * `overlayRef` before installing, so this is always immediately followed
   * by {@link restorePaths} for the same job.
   * @param sha - commit to reset to.
   * @param onLine - sink for reset progress.
   */
  async resetHard(sha: string, onLine: (line: SelfUpdateLogLine) => void): Promise<void> {
    const outcome = await runStreaming(this.ctx, this.config, ['git', 'reset', '--hard', sha], 'resetting', onLine)
    if (outcome.exitCode !== 0) throw new Error(`git reset --hard ${sha} exited ${String(outcome.exitCode)}`)
  }

  /**
   * Restore `paths` from `ref`'s tree onto the working tree and index,
   * layering this deployment's own files over the just-reset upstream tree.
   * @param ref - git ref (typically `config.overlayRef`) to restore paths from.
   * @param paths - paths (relative to `repoRoot`) to restore.
   * @param onLine - sink for checkout progress.
   */
  async restorePaths(ref: string, paths: readonly string[], onLine: (line: SelfUpdateLogLine) => void): Promise<void> {
    const outcome = await runStreaming(this.ctx, this.config, ['git', 'checkout', ref, '--', ...paths], 'overlaying', onLine)
    if (outcome.exitCode !== 0) throw new Error(`git checkout ${ref} -- ${paths.join(' ')} exited ${String(outcome.exitCode)}`)
  }

  /**
   * Stage every working-tree change and commit it, bypassing hooks: the
   * overlay's own paths are already reviewed source (restored verbatim from
   * `overlayRef`), not new work a commit hook needs to gate.
   * @param message - commit message.
   * @param onLine - sink for git's own progress output.
   */
  async commitAll(message: string, onLine: (line: SelfUpdateLogLine) => void): Promise<void> {
    const add = await runStreaming(this.ctx, this.config, ['git', 'add', '-A'], 'committing', onLine)
    if (add.exitCode !== 0) throw new Error(`git add -A exited ${String(add.exitCode)}`)
    const commit = await runStreaming(
      this.ctx, this.config, ['git', 'commit', '--no-verify', '-m', message], 'committing', onLine,
    )
    if (commit.exitCode !== 0) throw new Error(`git commit exited ${String(commit.exitCode)}`)
  }
}

const FIELD_SEPARATOR = '\u001f'

function parseCommitLine(text: string): SelfUpdateCommit {
  // String.prototype.split always returns at least one element, even for ''.
  const [sha, ...subjectParts] = text.trim().split(FIELD_SEPARATOR) as [string, ...string[]]
  return { sha, subject: subjectParts.join(FIELD_SEPARATOR) }
}
