/**
 * Source-safe self-update browser registration and Remote mount lifecycle.
 * @module @deepseek-ai/dsh-experimental-client-ui-self-update/client/mount
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { SelfUpdateController } from './controller.ts'
import { SelfUpdateAction } from './SelfUpdateAction.tsx'
import type { SelfUpdateInjected } from './slots.ts'
import { en, NS, zh } from './locales.ts'

export type { SelfUpdateActionResult, SelfUpdateLoadStatus, SelfUpdateRemote, SelfUpdateView } from './controller.ts'
export type { SelfUpdateActionProps, SelfUpdateInjected } from './slots.ts'
export type { SelfUpdateKey } from './locales.ts'

/** Required browser services for RPC, slots, and localized copy. */
export const inject = ['remote', 'slots', 'locale']

function registerUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-self-update: dictionaries')

  const controller = new SelfUpdateController(ctx.remote.selfUpdate)
  ctx.effect(() => () => { controller.dispose() }, 'client-ui-self-update: controller')

  const listeners = new Set<() => void>()
  ctx.on('connection/reset', () => {
    for (const listener of listeners) listener()
  })

  const injected: SelfUpdateInjected = {
    hooks: { update: controller },
    ensure: () => controller.ensure(),
    check: () => controller.check(),
    start: request => controller.start(request),
    onReconnect: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  ctx.slots.inject(
    'sidebar.footer.action',
    () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'self-update',
      order: 10,
      locale: NS,
      inject: () => injected,
    }, SelfUpdateAction),
  )
}

/**
 * Mount the generated self-update Remote contribution, then register the
 * sidebar Update button.
 * @param ctx - Client Context carrying slot, locale, and Remote services.
 * @param contribution - generated self-update Remote descriptors.
 * @returns disposer for both the UI registration and the Remote namespace.
 */
export async function mountSelfUpdateUi(
  ctx: ClientContext,
  contribution: TypertRemoteContribution,
): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.selfUpdate', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
