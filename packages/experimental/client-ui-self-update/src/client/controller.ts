/**
 * Browser-local object layer over the self-update Remote: the current
 * repository status plus the active job's accumulated log, kept live by one
 * `follow` subscription per open panel.
 * @module @deepseek-ai/dsh-experimental-client-ui-self-update/client/controller
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SelfUpdateFollowFrame,
  SelfUpdateJobSnapshot,
  SelfUpdateLogLine,
  SelfUpdateStartResult,
  SelfUpdateStatusValue,
} from '@deepseek-ai/dsh-experimental-self-update/types'

/** The four Remote calls this controller needs. */
export interface SelfUpdateRemote {
  status: () => Promise<RemoteResult<SelfUpdateStatusValue>>
  check: () => Promise<RemoteResult<SelfUpdateStatusValue>>
  start: () => Promise<RemoteResult<SelfUpdateStartResult>>
  follow: (signal: AbortSignal) => AsyncIterable<SelfUpdateFollowFrame>
}

/** Load state of the status read that seeds the panel. */
export type SelfUpdateLoadStatus = 'cold' | 'loading' | 'ready' | 'error'

/** Business reasons the Host may refuse a `start`, as the panel names them. */
export type SelfUpdateStartRefusal = Extract<SelfUpdateStartResult, { ok: false }>['error']['code']

/** Immutable view published to the Update button and its panel. */
export interface SelfUpdateView {
  status: SelfUpdateLoadStatus
  repository: SelfUpdateStatusValue | null
  job: SelfUpdateJobSnapshot | null
  log: readonly SelfUpdateLogLine[]
  /** Set once a `restarting` phase frame arrives, or the follow stream ends unexpectedly. */
  restarting: boolean
  /** Transport or Host failure message from the last Remote call, or `null`. */
  error: string | null
  /** Why the last `start` was refused; cleared by the next accepted `start` or status load. */
  refusal: SelfUpdateStartRefusal | null
}

const INITIAL_VIEW: SelfUpdateView = Object.freeze({
  status: 'cold',
  repository: null,
  job: null,
  log: [],
  restarting: false,
  error: null,
  refusal: null,
})

/** Settled action shape rendered by the panel's Check/Update controls. */
export type SelfUpdateActionResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } }

const OK: SelfUpdateActionResult = Object.freeze({ ok: true })

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Per-viewer object layer: one instance backs the sidebar button and its panel. */
export class SelfUpdateController implements HostObservable<SelfUpdateView> {
  private view = INITIAL_VIEW
  private readonly listeners = new Set<() => void>()
  private loadPromise: Promise<SelfUpdateActionResult> | null = null
  private followController: AbortController | null = null
  private disposed = false

  /** @param remote - the selfUpdate Remote namespace. */
  constructor(private readonly remote: SelfUpdateRemote) {}

  /** Return the cached immutable view. */
  getSnapshot = (): SelfUpdateView => this.view

  /** Subscribe to view replacement. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Load once; a failed load stays retryable. Also opens the live `follow`
   * subscription on first success, so opening the panel is enough to start
   * receiving job updates without a separate call.
   * @returns the settled load result, shared by concurrent callers.
   */
  ensure(): Promise<SelfUpdateActionResult> {
    if (this.view.status === 'ready') return Promise.resolve(OK)
    return this.refresh()
  }

  /** Re-read status, collapsing concurrent callers onto one in-flight read. */
  refresh(): Promise<SelfUpdateActionResult> {
    if (this.loadPromise !== null) return this.loadPromise
    this.publish({ ...this.view, status: 'loading', error: null })
    const pending = this.load()
    this.loadPromise = pending
    return pending.finally(() => { this.loadPromise = null })
  }

  /** Fetch upstream, then refresh status against it. */
  async check(): Promise<SelfUpdateActionResult> {
    const carried = await this.remote.check()
    if (this.disposed) return OK
    if (!carried.ok) return this.fail(carried.error.message)
    this.publish({ ...this.view, status: 'ready', repository: carried.value, error: null })
    return OK
  }

  /**
   * Begin one update attempt, with no further confirmation.
   * @returns the settled start result: success opens the live follow stream.
   */
  async start(): Promise<SelfUpdateActionResult> {
    const carried = await this.remote.start()
    if (this.disposed) return OK
    if (!carried.ok) return this.fail(carried.error.message)
    if (!carried.value.ok) {
      // job-already-running is not an error the user needs to see: another
      // tab (or a stale click) already has a job in flight, and this
      // controller's follow subscription already surfaces it once opened.
      if (carried.value.error.code === 'job-already-running') {
        this.openFollow()
        return OK
      }
      const { code } = carried.value.error
      this.publish({ ...this.view, refusal: code })
      return { ok: false, error: { code, message: code } }
    }
    this.publish({ ...this.view, job: carried.value.value, refusal: null })
    this.openFollow()
    return OK
  }

  /** Open the live follow subscription if one is not already open. */
  openFollow(): void {
    if (this.followController !== null) return
    const controller = new AbortController()
    this.followController = controller
    void this.runFollow(controller.signal)
  }

  /** Close the live follow subscription. */
  closeFollow(): void {
    this.followController?.abort()
    this.followController = null
  }

  /** Drop subscribers, close the stream, and refuse further work when the owning fiber unloads. */
  dispose(): void {
    this.disposed = true
    this.closeFollow()
    this.listeners.clear()
  }

  private async load(): Promise<SelfUpdateActionResult> {
    try {
      const carried = await this.remote.status()
      if (this.disposed) return OK
      if (!carried.ok) return this.fail(carried.error.message)
      this.publish({
        status: 'ready',
        repository: carried.value,
        job: carried.value.job,
        log: this.view.log,
        restarting: false,
        error: null,
        refusal: null,
      })
      this.openFollow()
      return OK
    } catch (error) {
      if (this.disposed) return OK
      return this.fail(messageOf(error))
    }
  }

  private async runFollow(signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of this.remote.follow(signal)) {
        // dispose() aborts this same signal before setting `disposed`, so a
        // real Remote's follow() stops yielding frames at the same moment
        // this check would fire; this guards a future follow() that could
        // still emit into an aborted signal instead of stopping immediately.
        /* v8 ignore next -- unreachable while dispose() always aborts this signal in the same synchronous step. */
        if (this.disposed) return
        this.applyFrame(frame)
      }
    } catch {
      // An aborted or dropped stream during a restart is expected; the
      // reconnect callback (wired by the client plugin) drives recovery.
    }
    if (this.disposed || this.followController?.signal !== signal) return
    // The stream ending on its own is not restarting: a Host `follow()` with
    // no job returns after one baseline frame, and an ordinary settlement
    // (up-to-date/failed/rolled-back) always delivers its 'done' frame —
    // which sets `finishedAt` — before the stream closes. A genuine restart
    // is caught by the explicit 'phase':'restarting' frame in applyFrame,
    // which runs first. Only a job still open (`finishedAt === null`) with no
    // further frames arriving is a stream that ended without explanation —
    // most plausibly the connection dropping mid-restart — so this is the
    // sole remaining case worth guessing at.
    if (this.view.job !== null && this.view.job.finishedAt === null) {
      this.publish({ ...this.view, restarting: true })
    }
  }

  private applyFrame(frame: SelfUpdateFollowFrame): void {
    if (frame.type === 'baseline') {
      this.publish({
        status: 'ready',
        repository: frame.status,
        job: frame.status.job,
        log: [...frame.log],
        restarting: false,
        error: null,
        refusal: this.view.refusal,
      })
      return
    }
    if (frame.type === 'phase') {
      this.publish({
        ...this.view,
        job: this.view.job === null ? null : { ...this.view.job, phase: frame.phase },
        restarting: frame.phase === 'restarting' || this.view.restarting,
      })
      return
    }
    if (frame.type === 'log') {
      this.publish({ ...this.view, log: [...this.view.log, frame.line] })
      return
    }
    this.publish({ ...this.view, job: frame.job })
  }

  private fail(message: string): SelfUpdateActionResult {
    this.publish({ ...this.view, status: 'error', error: message })
    return { ok: false, error: { code: 'transport', message } }
  }

  private publish(view: SelfUpdateView): void {
    this.view = Object.freeze(view)
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[client-ui-self-update] subscriber threw:', error)
      }
    }
  }
}
