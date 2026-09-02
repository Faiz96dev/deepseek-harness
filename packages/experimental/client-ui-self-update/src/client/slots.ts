/**
 * The Update entry's injected face. The target 'sidebar.footer.action' slot
 * is declared and typed by ui-sidebar; this package only contributes the
 * entry, so no SlotMap merge lives here. Live state arrives through the
 * `update` hook (the framework standard kit binds it into `useUpdate`);
 * inject carries the check/start verbs and the reconnect subscription.
 * @module @deepseek-ai/dsh-experimental-client-ui-self-update/client/slots
 */

import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls this package's LocaleNamespaceMap merge (the 'self-update' seat).
import type {} from './locales.ts'
import type { SelfUpdateActionResult, SelfUpdateView } from './controller.ts'
import type { SelfUpdateStartRequest } from '@deepseek-ai/dsh-experimental-self-update/types'

/** Injected business face of the sidebar Update entry. */
export interface SelfUpdateInjected {
  hooks: {
    /** The current repository, job, and log state. */
    update: HostObservable<SelfUpdateView>
  }
  /** Load status once, on first interaction, and open the live follow stream. */
  ensure: () => Promise<SelfUpdateActionResult>
  /** Fetch upstream, then refresh status against it. */
  check: () => Promise<SelfUpdateActionResult>
  /**
   * Begin one update attempt.
   * @param request - optional acknowledgement of active Sessions.
   */
  start: (request?: SelfUpdateStartRequest) => Promise<SelfUpdateActionResult>
  /** Subscribe to the physical connection re-establishing after the restart. */
  onReconnect: (listener: () => void) => () => void
}

/** Full props of the sidebar Update entry. */
export type SelfUpdateActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & InjectFace<SelfUpdateInjected>
  & PropsLocale<'self-update'>
