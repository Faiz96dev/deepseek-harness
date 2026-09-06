#!/usr/bin/env node
/**
 * Self-update `buildArgv` entry point: this file itself lives inside the
 * overlay, so it exists only once the self-update job has restored the
 * overlay's paths onto the freshly reset upstream tree, before this script
 * runs. A pristine `upstream/master` checkout does not register these three
 * packages in the root `tsconfig.host.json`/`tsconfig.client.json`
 * aggregates or the root `tsdown.config.ts` workspace glob's dependency
 * order, so their own build step runs here, sandwiched around the ordinary
 * root build:
 *
 * 1. The root `tsc -b` aggregates emit every upstream package's own
 *    `lib/types` via their composite project references, in dependency
 *    order, before they ever reach the broad per-package test-file glob
 *    that (harmlessly) sweeps in these three packages' own test files and
 *    reports them as out-of-project (`TS6307`) — a real but irrelevant
 *    error for files no upstream package's build depends on, so this step's
 *    own exit code is not treated as fatal here.
 * 2. `tsdown`'s host pass turns every upstream package's `lib/types` into
 *    its runtime `lib/index.js` and, for a Typert Remote service, its
 *    `lib/typert.host.js`/`lib/typert.remote-client.js` — including the
 *    `/remote` subpath exports this package's own three packages import
 *    from upstream (e.g. `@deepseek-ai/dsh-client-file-upload/remote`).
 * 3. Only now can this package's own three `tsconfig.json` files build
 *    cleanly against a complete upstream `lib/`.
 * 4. Re-running `tsdown`'s host and client passes picks up these three
 *    packages' own freshly emitted `lib/types`, producing their own
 *    `lib/index.js`/`lib/typert.*`/`lib/client.js`.
 * 5. The ordinary root `build:web` build never depends on this overlay.
 *
 * Plain Node, zero dependencies: this runs as a raw `buildArgv`, before
 * `pnpm install` for the overlay's own dependencies could have been resolved
 * by anything other than the repository's own already-installed toolchain.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const overlayRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(overlayRoot, '..', '..', '..', '..')
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')

const OVERLAY_PACKAGE_TSCONFIGS = [
  'packages/experimental/self-update/tsconfig.json',
  'packages/experimental/client-ui-self-update/tsconfig.json',
  'packages/experimental/self-update-web-profile/tsconfig.json',
]

/**
 * Run one build step, inheriting stdio so its output reaches the self-update
 * job's own captured stdout/stderr (this script is itself the job's direct
 * child).
 * @param command - argv[0].
 * @param args - remaining argv.
 * @param options - `tolerateExitCode` accepts a nonzero exit without
 * throwing, for the two root `tsc -b` steps whose broad file list reports
 * this package's own unregistered test files as out-of-project — real
 * errors, but confined to files no build output depends on.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0 && options.tolerateExitCode !== true) {
    throw new Error(`self-update overlay build: ${command} ${args.join(' ')} exited ${String(result.status ?? result.signal)}`)
  }
}

run(process.execPath, [tsc, '-b', 'tsconfig.host.json'], { tolerateExitCode: true })
run('npx', ['tsdown', '--env.DSH_BUILD_FACE', 'host'])
for (const tsconfig of OVERLAY_PACKAGE_TSCONFIGS) run(process.execPath, [tsc, '-b', tsconfig])
run('npx', ['tsdown', '--env.DSH_BUILD_FACE', 'host'])

run(process.execPath, [tsc, '-b', 'tsconfig.client.json'], { tolerateExitCode: true })
run('npx', ['tsdown', '--env.DSH_BUILD_FACE', 'client'])
run(process.execPath, [tsc, '-b', 'packages/experimental/client-ui-self-update/tsconfig.json'])
run('npx', ['tsdown', '--env.DSH_BUILD_FACE', 'client'])

run('pnpm', ['run', 'build:web'])
