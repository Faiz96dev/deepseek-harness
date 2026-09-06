/**
 * Public request, value, and failure vocabulary for the self-update job. This
 * module contains types only so the generated Remote client can consume it
 * without importing Host runtime code.
 * @module @deepseek-ai/dsh-experimental-self-update/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity for one update job attempt, crossing the Remote boundary. */
export type SelfUpdateJobId = Branded<'SelfUpdateJobId'>

/** Named steps of one update run, in execution order. */
export type SelfUpdatePhase =
  | 'preflight'
  | 'fetching'
  | 'backing-up'
  | 'resetting'
  | 'overlaying'
  | 'installing'
  | 'building'
  | 'verifying'
  | 'committing'
  | 'restarting'

/** Terminal outcomes a finished job settles into. */
export type SelfUpdateOutcome = 'succeeded' | 'up-to-date' | 'failed' | 'rolled-back'

/** One repository fact pair: local HEAD or the fetched upstream head. */
export interface SelfUpdateCommit {
  readonly sha: string
  readonly subject: string
}

/** Current repository and job state, read at any time without side effects. */
export interface SelfUpdateStatusValue {
  /** `version` of the `package.json` at `repoRoot`: the checked-out release the running process was built from. */
  readonly version: string
  readonly head: SelfUpdateCommit
  /** Fetched upstream head; `null` until a `check` has run this process lifetime. */
  readonly remoteHead: SelfUpdateCommit | null
  /** Commits local HEAD is missing from the fetched upstream head; `null` before the first `check`. */
  readonly behind: number | null
  /** Commits upstream is missing from local HEAD (this deployment's own overlay commit, if any). */
  readonly ahead: number
  /** Whether the working tree currently carries uncommitted changes. */
  readonly dirty: boolean
  /** The in-progress job, or `null` when idle. */
  readonly job: SelfUpdateJobSnapshot | null
  /** The most recently finished job this process instance has observed. */
  readonly lastRun: SelfUpdateJobSnapshot | null
}

/** One bounded, appended-to log line surfaced to the browser. */
export interface SelfUpdateLogLine {
  readonly seq: number
  readonly phase: SelfUpdatePhase
  readonly stream: 'stdout' | 'stderr' | 'system'
  readonly text: string
  readonly at: number
}

/** Stable failure vocabulary for one update attempt. */
export type SelfUpdateFailure =
  | { readonly code: 'dirty-working-tree' }
  | { readonly code: 'job-already-running' }
  | { readonly code: 'app-exit-unavailable' }
  | { readonly code: 'overlay-ref-missing'; readonly ref: string }
  | { readonly code: 'fetch-failed'; readonly message: string }
  | { readonly code: 'backup-failed'; readonly message: string }
  | { readonly code: 'reset-failed'; readonly message: string }
  | { readonly code: 'overlay-failed'; readonly message: string }
  | { readonly code: 'install-failed'; readonly exitCode: number | null; readonly message: string }
  | { readonly code: 'build-failed'; readonly exitCode: number | null; readonly message: string }
  | { readonly code: 'verify-failed'; readonly exitCode: number | null; readonly message: string }
  | { readonly code: 'commit-failed'; readonly message: string }
  | { readonly code: 'rollback-failed'; readonly message: string }
  | { readonly code: 'unexpected'; readonly message: string }

/** One update job's current or final state. */
export interface SelfUpdateJobSnapshot {
  readonly id: SelfUpdateJobId
  /** Current phase while running; the phase last reached before settling once finished. */
  readonly phase: SelfUpdatePhase
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly outcome: SelfUpdateOutcome | null
  readonly failure: SelfUpdateFailure | null
  readonly fromCommit: SelfUpdateCommit | null
  readonly toCommit: SelfUpdateCommit | null
  readonly backupPath: string | null
}

/** Successful public operation result. */
export interface SelfUpdateSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** Rejected public operation result with a stable business failure. */
export interface SelfUpdateRejected<E extends SelfUpdateFailure> {
  readonly ok: false
  readonly error: E
}

/** Result returned by the self-update `start` operation. */
export type SelfUpdateStartResult =
  | SelfUpdateSuccess<SelfUpdateJobSnapshot>
  | SelfUpdateRejected<Extract<SelfUpdateFailure, { code: 'job-already-running' | 'dirty-working-tree' | 'app-exit-unavailable' }>>

/** One frame of the `follow` logical stream: a full baseline, then increments. */
export type SelfUpdateFollowFrame =
  | { readonly type: 'baseline'; readonly status: SelfUpdateStatusValue; readonly log: readonly SelfUpdateLogLine[] }
  | { readonly type: 'phase'; readonly phase: SelfUpdatePhase }
  | { readonly type: 'log'; readonly line: SelfUpdateLogLine }
  | { readonly type: 'done'; readonly job: SelfUpdateJobSnapshot }
