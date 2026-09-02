/**
 * SelfUpdateController: the browser-local object layer over the self-update
 * Remote. These specs pin the load/refresh/check/start contract, the live
 * `follow` subscription's baseline-then-increments application, the
 * restarting flag once a stream ends or reaches its restart phase, and
 * disposal stopping further publication.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SelfUpdateFollowFrame, SelfUpdateJobSnapshot, SelfUpdateStatusValue,
} from '@deepseek-ai/dsh-experimental-self-update/types'
import { SelfUpdateController, type SelfUpdateRemote } from '../src/client/controller.ts'

const STATUS: SelfUpdateStatusValue = {
  version: '1.2.3',
  head: { sha: 'a'.repeat(40), subject: 'initial' },
  remoteHead: null,
  behind: null,
  ahead: 0,
  dirty: false,
  activeSessions: 0,
  job: null,
  lastRun: null,
}

const JOB: SelfUpdateJobSnapshot = {
  id: 'job-1' as SelfUpdateJobSnapshot['id'],
  phase: 'fetching',
  startedAt: 0,
  finishedAt: null,
  outcome: null,
  failure: null,
  fromCommit: null,
  toCommit: null,
  backupPath: null,
}

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function carrierFailure<T>(message: string): RemoteResult<T> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/** A follow implementation that never yields until the test resolves it. */
function neverEndingFollow(): (signal: AbortSignal) => AsyncIterable<SelfUpdateFollowFrame> {
  return async function* neverEnds(signal: AbortSignal) {
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }
}

function fakeRemote(overrides: Partial<SelfUpdateRemote> = {}): SelfUpdateRemote {
  return {
    status: () => Promise.resolve(ok(STATUS)),
    check: () => Promise.resolve(ok(STATUS)),
    start: () => Promise.resolve(ok({ ok: true, value: JOB })),
    follow: neverEndingFollow(),
    ...overrides,
  }
}

/** A follow implementation whose test-controlled queue can push frames on demand. */
function deliverableFollow(): {
  follow: (signal: AbortSignal) => AsyncIterable<SelfUpdateFollowFrame>
  deliver: (frame: SelfUpdateFollowFrame) => void
} {
  const queue: SelfUpdateFollowFrame[] = []
  let wake: (() => void) | undefined
  return {
    deliver: (frame) => { queue.push(frame); wake?.() },
    async *follow(signal: AbortSignal) {
      while (!signal.aborted) {
        const frame = queue.shift()
        if (frame !== undefined) { yield frame; continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    },
  }
}

describe('SelfUpdateController', () => {
  it('starts cold and loads status once on ensure, opening the follow stream', async () => {
    const status = vi.fn(() => Promise.resolve(ok(STATUS)))
    const remote = fakeRemote({ status })
    const controller = new SelfUpdateController(remote)

    expect(controller.getSnapshot().status).toBe('cold')
    expect(await controller.ensure()).toEqual({ ok: true })
    expect(controller.getSnapshot().status).toBe('ready')
    expect(controller.getSnapshot().repository).toEqual(STATUS)
    expect(status).toHaveBeenCalledOnce()

    await controller.ensure()
    expect(status).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('collapses concurrent refresh calls onto one in-flight load', async () => {
    const pending = Promise.withResolvers<RemoteResult<SelfUpdateStatusValue>>()
    const status = vi.fn(() => pending.promise)
    const controller = new SelfUpdateController(fakeRemote({ status }))

    const first = controller.refresh()
    const second = controller.refresh()
    expect(status).toHaveBeenCalledOnce()
    pending.resolve(ok(STATUS))
    await Promise.all([first, second])
    controller.dispose()
  })

  it('reports a carrier failure from status as a transport error, and stays retryable', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce(carrierFailure<SelfUpdateStatusValue>('offline'))
      .mockResolvedValueOnce(ok(STATUS))
    const controller = new SelfUpdateController(fakeRemote({ status }))

    const failed = await controller.ensure()
    expect(failed).toEqual({ ok: false, error: { code: 'transport', message: 'offline' } })
    expect(controller.getSnapshot().status).toBe('error')
    expect(controller.getSnapshot().error).toBe('offline')

    expect(await controller.ensure()).toEqual({ ok: true })
    expect(controller.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('reports a thrown status error as a transport error', async () => {
    const status = vi.fn(() => Promise.reject(new Error('network down')))
    const controller = new SelfUpdateController(fakeRemote({ status }))
    const result = await controller.ensure()
    expect(result).toEqual({ ok: false, error: { code: 'transport', message: 'network down' } })
    controller.dispose()
  })

  it('reports a non-Error thrown status value stringified', async () => {
    const status = vi.fn<() => Promise<never>>().mockRejectedValue('boom')
    const controller = new SelfUpdateController(fakeRemote({ status }))
    const result = await controller.ensure()
    expect(result).toEqual({ ok: false, error: { code: 'transport', message: 'boom' } })
    controller.dispose()
  })

  it('fetches upstream and refreshes status on check', async () => {
    const behindStatus = { ...STATUS, behind: 2 }
    const check = vi.fn(() => Promise.resolve(ok(behindStatus)))
    const controller = new SelfUpdateController(fakeRemote({ check }))

    expect(await controller.check()).toEqual({ ok: true })
    expect(controller.getSnapshot().repository).toEqual(behindStatus)
    expect(controller.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('reports a carrier failure from check as a transport error', async () => {
    const check = vi.fn(() => Promise.resolve(carrierFailure<SelfUpdateStatusValue>('check offline')))
    const controller = new SelfUpdateController(fakeRemote({ check }))
    expect(await controller.check()).toEqual({ ok: false, error: { code: 'transport', message: 'check offline' } })
    controller.dispose()
  })

  it('publishes the started job and opens the follow stream on a successful start', async () => {
    const start = vi.fn(() => Promise.resolve(ok({ ok: true as const, value: JOB })))
    const controller = new SelfUpdateController(fakeRemote({ start }))

    expect(await controller.start()).toEqual({ ok: true })
    expect(controller.getSnapshot().job).toEqual(JOB)
    expect(start).toHaveBeenCalledWith({})
    controller.dispose()
  })

  it('forwards the acknowledgeActiveSessions request', async () => {
    const start = vi.fn(() => Promise.resolve(ok({ ok: true as const, value: JOB })))
    const controller = new SelfUpdateController(fakeRemote({ start }))
    await controller.start({ acknowledgeActiveSessions: true })
    expect(start).toHaveBeenCalledWith({ acknowledgeActiveSessions: true })
    controller.dispose()
  })

  it('reports a carrier failure from start as a transport error', async () => {
    const start = vi.fn(() => Promise.resolve(carrierFailure<{ ok: true; value: SelfUpdateJobSnapshot }>('start offline')))
    const controller = new SelfUpdateController(fakeRemote({ start }))
    expect(await controller.start()).toEqual({ ok: false, error: { code: 'transport', message: 'start offline' } })
    controller.dispose()
  })

  it('surfaces an ordinary business refusal from start with its own code as the message', async () => {
    const start = vi.fn(() => Promise.resolve(ok({
      ok: false as const, error: { code: 'dirty-working-tree' as const },
    })))
    const controller = new SelfUpdateController(fakeRemote({ start }))
    expect(await controller.start()).toEqual({
      ok: false, error: { code: 'dirty-working-tree', message: 'dirty-working-tree' },
    })
    controller.dispose()
  })

  it('silently opens the follow stream instead of surfacing job-already-running as an error', async () => {
    const start = vi.fn(() => Promise.resolve(ok({
      ok: false as const, error: { code: 'job-already-running' as const },
    })))
    const follow = vi.fn(neverEndingFollow())
    const controller = new SelfUpdateController(fakeRemote({ start, follow }))
    expect(await controller.start()).toEqual({ ok: true })
    expect(follow).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('does not open a second follow stream while one is already open', async () => {
    const follow = vi.fn(neverEndingFollow())
    const controller = new SelfUpdateController(fakeRemote({ follow }))
    controller.openFollow()
    controller.openFollow()
    expect(follow).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('applies a baseline frame, replacing status/job/log wholesale', async () => {
    const { follow, deliver } = deliverableFollow()
    const controller = new SelfUpdateController(fakeRemote({ follow }))
    controller.openFollow()

    deliver({
      type: 'baseline',
      status: { ...STATUS, job: JOB },
      log: [{ seq: 0, phase: 'fetching', stream: 'stdout', text: 'hello', at: 0 }],
    })
    await vi.waitFor(() => {
      expect(controller.getSnapshot().job).toEqual(JOB)
      expect(controller.getSnapshot().log).toHaveLength(1)
      expect(controller.getSnapshot().restarting).toBe(false)
    })
    controller.dispose()
  })

  it('updates only the phase of the current job on a phase frame, and marks restarting on the restarting phase', async () => {
    const { follow, deliver } = deliverableFollow()
    const controller = new SelfUpdateController(fakeRemote({ follow }))
    controller.openFollow()
    deliver({ type: 'baseline', status: { ...STATUS, job: JOB }, log: [] })
    await vi.waitFor(() => { expect(controller.getSnapshot().job).toEqual(JOB) })

    deliver({ type: 'phase', phase: 'building' })
    await vi.waitFor(() => { expect(controller.getSnapshot().job?.phase).toBe('building') })
    expect(controller.getSnapshot().restarting).toBe(false)

    deliver({ type: 'phase', phase: 'restarting' })
    await vi.waitFor(() => { expect(controller.getSnapshot().restarting).toBe(true) })
    controller.dispose()
  })

  it('ignores a phase frame when no job is known yet', async () => {
    const { follow, deliver } = deliverableFollow()
    const controller = new SelfUpdateController(fakeRemote({ follow }))
    controller.openFollow()
    deliver({ type: 'baseline', status: STATUS, log: [] })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })

    deliver({ type: 'phase', phase: 'building' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(controller.getSnapshot().job).toBeNull()
    controller.dispose()
  })

  it('appends a log frame to the accumulated log', async () => {
    const { follow, deliver } = deliverableFollow()
    const controller = new SelfUpdateController(fakeRemote({ follow }))
    controller.openFollow()
    deliver({ type: 'baseline', status: STATUS, log: [] })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })

    deliver({ type: 'log', line: { seq: 0, phase: 'fetching', stream: 'stdout', text: 'line one', at: 0 } })
    await vi.waitFor(() => { expect(controller.getSnapshot().log).toHaveLength(1) })
    controller.dispose()
  })

  it('replaces the job snapshot wholesale on a done frame', async () => {
    const { follow, deliver } = deliverableFollow()
    const controller = new SelfUpdateController(fakeRemote({ follow }))
    controller.openFollow()
    deliver({ type: 'baseline', status: { ...STATUS, job: JOB }, log: [] })
    await vi.waitFor(() => { expect(controller.getSnapshot().job).toEqual(JOB) })

    const finished: SelfUpdateJobSnapshot = { ...JOB, finishedAt: 1, outcome: 'succeeded' }
    deliver({ type: 'done', job: finished })
    await vi.waitFor(() => { expect(controller.getSnapshot().job).toEqual(finished) })
    controller.dispose()
  })

  it('marks restarting when the follow stream ends without a done frame', async () => {
    const controller = new SelfUpdateController(fakeRemote({
      follow: async function* endsImmediately() {},
    }))
    controller.openFollow()
    await vi.waitFor(() => { expect(controller.getSnapshot().restarting).toBe(true) })
    controller.dispose()
  })

  it('does not mark restarting when a newer follow generation has already replaced this one', async () => {
    const controller = new SelfUpdateController(fakeRemote({
      follow: async function* endsImmediately() {},
    }))
    controller.openFollow()
    controller.closeFollow()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(controller.getSnapshot().restarting).toBe(false)
    controller.dispose()
  })

  it('ignores late frames and does not mark restarting after dispose', async () => {
    const { follow, deliver } = deliverableFollow()
    const controller = new SelfUpdateController(fakeRemote({ follow }))
    controller.openFollow()
    controller.dispose()
    deliver({ type: 'baseline', status: STATUS, log: [] })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(controller.getSnapshot().status).toBe('cold')
  })

  it('stops notifying subscribers after dispose, and isolates a throwing subscriber', async () => {
    const controller = new SelfUpdateController(fakeRemote())
    const notifications: number[] = []
    controller.subscribe(() => { notifications.push(1) })
    controller.subscribe(() => { throw new Error('subscriber failure') })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await controller.ensure()
    expect(notifications.length).toBeGreaterThan(0)
    expect(errorSpy).toHaveBeenCalled()

    const countBefore = notifications.length
    controller.dispose()
    await controller.check()
    expect(notifications.length).toBe(countBefore)
    errorSpy.mockRestore()
  })

  it('unsubscribes a listener when its disposer is called', async () => {
    const controller = new SelfUpdateController(fakeRemote())
    const listener = vi.fn()
    const off = controller.subscribe(listener)
    off()
    await controller.ensure()
    expect(listener).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('discards a start reply that resolves after dispose', async () => {
    const pending = Promise.withResolvers<RemoteResult<{ ok: true; value: SelfUpdateJobSnapshot }>>()
    const controller = new SelfUpdateController(fakeRemote({ start: () => pending.promise }))
    const settling = controller.start()
    controller.dispose()
    pending.resolve(ok({ ok: true, value: JOB }))
    expect(await settling).toEqual({ ok: true })
    expect(controller.getSnapshot().job).toBeNull()
  })

  it('discards a status reply that resolves after dispose, without publishing it', async () => {
    const pending = Promise.withResolvers<RemoteResult<SelfUpdateStatusValue>>()
    const controller = new SelfUpdateController(fakeRemote({ status: () => pending.promise }))
    const settling = controller.ensure()
    controller.dispose()
    // ensure()'s synchronous publish (status: 'loading') already ran before
    // dispose; what this test pins is that the reply arriving afterward
    // neither errors nor overwrites that view with the resolved repository.
    pending.resolve(ok(STATUS))
    expect(await settling).toEqual({ ok: true })
    expect(controller.getSnapshot().status).toBe('loading')
    expect(controller.getSnapshot().repository).toBeNull()
  })

  it('swallows a status rejection that arrives after dispose, without publishing an error', async () => {
    const pending = Promise.withResolvers<RemoteResult<SelfUpdateStatusValue>>()
    const controller = new SelfUpdateController(fakeRemote({ status: () => pending.promise }))
    const settling = controller.ensure()
    controller.dispose()
    pending.reject(new Error('too late'))
    expect(await settling).toEqual({ ok: true })
    expect(controller.getSnapshot().status).toBe('loading')
    expect(controller.getSnapshot().error).toBeNull()
  })

  it('stops applying follow frames the instant dispose runs mid-iteration', async () => {
    const { follow, deliver } = deliverableFollow()
    const controller = new SelfUpdateController(fakeRemote({ follow }))
    controller.openFollow()
    deliver({ type: 'baseline', status: STATUS, log: [] })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('ready') })

    // dispose() flips `disposed` synchronously, before runFollow's loop can
    // observe a frame already sitting in the queue when it resumes.
    deliver({ type: 'log', line: { seq: 0, phase: 'fetching', stream: 'stdout', text: 'late', at: 0 } })
    controller.dispose()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(controller.getSnapshot().log).toHaveLength(0)
  })
})
