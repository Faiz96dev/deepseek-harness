/** Browser entry binding the generated self-update Remote artifact to its Client UI. */

import selfUpdateRemote from '@deepseek-ai/dsh-experimental-self-update/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { mountSelfUpdateUi } from './mount.ts'

export { inject } from './mount.ts'
export type { SelfUpdateActionResult, SelfUpdateLoadStatus, SelfUpdateRemote, SelfUpdateView } from './mount.ts'
export type { SelfUpdateActionProps, SelfUpdateInjected } from './mount.ts'
export type { SelfUpdateKey } from './mount.ts'

/** Mount the generated self-update Remote contribution and its browser UI. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  return await mountSelfUpdateUi(ctx, selfUpdateRemote)
}
