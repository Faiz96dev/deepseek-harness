/** Package-owned invariant companion. @module @deepseek-ai/dsh-experimental-self-update/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-self-update'

/** Cordis companion plugin name. */
export const name = 'self-update-invariant'
/** Services required before the companion can reserve and check package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the update job's state is process-local and owned by
 * exactly one `SelfUpdateService` instance; no durable or shared authority
 * exists for a second party to check it against.
 */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['selfUpdate'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
