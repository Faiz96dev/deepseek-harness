#!/usr/bin/env node
/**
 * Self-update `buildArgv` entry point: this file itself lives inside the
 * overlay, so it exists only once the self-update job has restored the
 * overlay's paths onto the freshly reset upstream tree, before this script
 * runs. A pristine `upstream/master` checkout does not register these three
 * packages in the root `tsconfig.host.json`/`tsconfig.client.json`
 * aggregates, so their emitted `lib/types` (which the root `tsdown` build's
 * glob then consumes) must be produced here, directly, before the ordinary
 * root build runs.
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

const OVERLAY_PACKAGE_TSCONFIGS = [
  'packages/experimental/self-update/tsconfig.json',
  'packages/experimental/client-ui-self-update/tsconfig.json',
  'packages/experimental/self-update-web-profile/tsconfig.json',
]

/**
 * Run one step, inheriting stdio so its output reaches the self-update job's
 * own captured stdout/stderr (this script is itself the job's direct child).
 * @param command - argv[0].
 * @param args - remaining argv.
 */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`self-update overlay build: ${command} ${args.join(' ')} exited ${String(result.status ?? result.signal)}`)
  }
}

const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
for (const tsconfig of OVERLAY_PACKAGE_TSCONFIGS) {
  run(process.execPath, [tsc, '-b', tsconfig])
}
run('pnpm', ['run', 'build'])
