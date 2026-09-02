/** Package-owned invariant companion for the self-update Web presentation. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-client-ui-self-update'

/** Cordis companion plugin name. */
export const name = 'client-ui-self-update-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: Remote is authoritative and the package owns only one disposable slot registration. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant ownership.
 * @param ctx - Cordis Context carrying the invariant registry.
 * @returns disposer for the package registration.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
