import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-experimental-self-update/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { SelfUpdateAction } from '../src/client/SelfUpdateAction.tsx'
import type { SelfUpdateInjected } from '../src/client/slots.ts'
import { inject, mountSelfUpdateUi } from '../src/client/mount.ts'
import { apply as clientApply } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const REMOTE: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-experimental-self-update',
  descriptors: [],
}

const STATUS = {
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

async function bench(options: { registrationFailure?: boolean } = {}) {
  const ctx = new Context()
  const calls: { method: string; args: unknown[] }[] = []
  class RemoteService extends Service {
    readonly disposeMount = vi.fn(() => Promise.resolve())
    readonly mount = vi.fn((_contribution: unknown) => Promise.resolve(this.disposeMount))

    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }

    $mount(contribution: unknown): Promise<() => Promise<void>> {
      return this.mount(contribution)
    }
  }
  const remote = new RemoteService(ctx)
  ctx.provide('remote.selfUpdate', {
    status: (...args: unknown[]) => {
      calls.push({ method: 'selfUpdate/status', args })
      return Promise.resolve({ ok: true as const, value: STATUS })
    },
    check: (...args: unknown[]) => {
      calls.push({ method: 'selfUpdate/check', args })
      return Promise.resolve({ ok: true as const, value: { ...STATUS, behind: 1 } })
    },
    start: (...args: unknown[]) => {
      calls.push({ method: 'selfUpdate/start', args })
      return Promise.resolve({ ok: true as const, value: { ok: true as const, value: { ...JOB } } })
    },
    async *follow(signal: AbortSignal) {
      calls.push({ method: 'selfUpdate/follow', args: [] })
      yield { type: 'baseline' as const, status: STATUS, log: [] }
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    },
  })
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  const collapseFooter = ctx.slots.register({
    name: 'root',
    children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  if (options.registrationFailure === true) {
    vi.spyOn(ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot registration failed') })
  }
  const fiber = options.registrationFailure === true
    ? ctx.plugin({ apply() {} })
    : ctx.plugin({ inject: [...inject], apply: clientCtx => mountSelfUpdateUi(clientCtx, REMOTE) })
  const activation: Promise<unknown> = options.registrationFailure === true
    ? mountSelfUpdateUi(ctx, REMOTE).catch((error: unknown) => error)
    : fiber.await()
  if (options.registrationFailure !== true) {
    await activation
  } else {
    await fiber.await()
  }
  const entry = () => ctx.slots.entries('sidebar.footer.action')
    .find(candidate => candidate.component === SelfUpdateAction)
  return { ctx, fiber, activation, calls, remote, entry, collapseFooter }
}

const JOB = {
  id: 'job-1',
  phase: 'fetching' as const,
  startedAt: 0,
  finishedAt: null,
  outcome: null,
  failure: null,
  fromCommit: null,
  toCommit: null,
  backupPath: null,
}

describe('ui-self-update browser plugin', () => {
  it('registers one disposable sidebar footer action backed by the selfUpdate Remote', async () => {
    const b = await bench()
    expect(inject).toEqual(['remote', 'slots', 'locale'])
    expect(b.entry()).toMatchObject({
      options: { id: 'self-update', order: 10 },
      locale: 'self-update',
    })
    expect(b.remote.mount).toHaveBeenCalledOnce()
    expect(b.remote.mount).toHaveBeenCalledWith(REMOTE)

    const injected = (b.entry()!.inject as unknown as () => SelfUpdateInjected)()
    expect((await injected.ensure()).ok).toBe(true)
    expect((await injected.refresh()).ok).toBe(true)
    expect((await injected.check()).ok).toBe(true)
    expect((await injected.start()).ok).toBe(true)
    expect(b.calls.map(call => call.method)).toContain('selfUpdate/status')
    expect(b.calls.map(call => call.method)).toContain('selfUpdate/check')
    expect(b.calls.map(call => call.method)).toContain('selfUpdate/start')

    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    expect(b.remote.disposeMount).toHaveBeenCalledOnce()
  })

  it('unmounts the Remote contribution when later Client registration fails', async () => {
    const b = await bench({ registrationFailure: true })
    await expect(b.activation).resolves.toMatchObject({ message: 'slot registration failed' })
    expect(b.remote.mount).toHaveBeenCalledOnce()
    expect(b.remote.disposeMount).toHaveBeenCalledOnce()
  })

  it('re-registers after the sidebar footer slot is collapsed and declared again', async () => {
    const b = await bench()
    expect(b.entry()).toBeDefined()
    b.collapseFooter()
    expect(b.entry()).toBeUndefined()
    b.ctx.slots.register({
      name: 'root',
      children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } },
    } as never, () => null)
    await Promise.resolve()
    expect(b.entry()).toBeDefined()
  })

  it('notifies onReconnect subscribers on connection/reset', async () => {
    const b = await bench()
    const injected = (b.entry()!.inject as unknown as () => SelfUpdateInjected)()
    const listener = vi.fn()
    const off = injected.onReconnect(listener)
    b.ctx.emit('connection/reset')
    expect(listener).toHaveBeenCalledOnce()
    off()
    b.ctx.emit('connection/reset')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('keeps the node half inert', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('mounts through the real client entry, using the generated Remote descriptor', async () => {
    const ctx = new Context()
    class RemoteService extends Service {
      readonly disposeMount = vi.fn(() => Promise.resolve())
      readonly mount = vi.fn((_contribution: unknown) => Promise.resolve(this.disposeMount))

      constructor(serviceCtx: Context) {
        super(serviceCtx, 'remote')
      }

      $mount(contribution: unknown): Promise<() => Promise<void>> {
        return this.mount(contribution)
      }
    }
    const remote = new RemoteService(ctx)
    ctx.provide('remote.selfUpdate', {
      status: () => Promise.resolve({ ok: true as const, value: {} }),
      check: () => Promise.resolve({ ok: true as const, value: {} }),
      start: () => Promise.resolve({ ok: true as const, value: { ok: true as const, value: {} } }),
      async *follow() {},
    })
    ctx.provide('locale', new LocaleRuntime(ctx))
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } },
    } as never, () => null)

    const fiber = ctx.plugin({ apply: clientApply })
    await fiber.await()
    expect(remote.mount).toHaveBeenCalledOnce()
    const [contribution] = remote.mount.mock.calls[0] as [{ package: string }]
    expect(contribution.package).toBe('@deepseek-ai/dsh-experimental-self-update')

    await fiber.dispose()
    expect(remote.disposeMount).toHaveBeenCalledOnce()
  })
})
