/** The experimental Web bundle must carry one parseable self-update Host+Client layer. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as WebProfileInvariant from '../src/invariant.ts'

const REQUIRED_CONFIG_KEYS = [
  'repoRoot', 'remoteName', 'branch', 'installArgv', 'buildArgv', 'verifyArgv',
  'extraPathDirs', 'backupRoot', 'keepBackups', 'sessionsDir', 'storagesDir',
  'attachmentsDir', 'graceMs', 'maxLogLines', 'logDir',
]

describe('self-update Web profile bundle', () => {
  it('declares a private parseable layer containing the self-update Host and Client rows', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      private?: boolean
      publishConfig?: unknown
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.private).toBe(true)
    expect(manifest.publishConfig).toBeUndefined()
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toEqual({
      '@deepseek-ai/dsh-experimental-self-update': 'workspace:^',
      '@deepseek-ai/dsh-experimental-client-ui-self-update': 'workspace:^',
    })

    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as { insert?: { id?: string; name?: string; config?: Record<string, unknown> }[] }[]
    const rows = parsed.flatMap(patch => patch.insert ?? [])
    expect(rows.map(row => ({ id: row.id, name: row.name }))).toEqual([
      { id: 'self-update', name: '@deepseek-ai/dsh-experimental-self-update' },
      { id: 'ui-self-update', name: '@deepseek-ai/dsh-experimental-client-ui-self-update' },
    ])

    const selfUpdateRow = rows.find(row => row.id === 'self-update')
    expect(Object.keys(selfUpdateRow?.config ?? {}).sort()).toEqual([...REQUIRED_CONFIG_KEYS].sort())
  })

  it('reserves package ownership without installing a runtime audit', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(WebProfileInvariant)
    await fiber.await()
    expect(WebProfileInvariant.name).toBe('self-update-web-profile-invariant')
    expect(WebProfileInvariant.inject).toEqual(['invariants'])
    expect(() => {
      Reflect.apply(ctx.emit.bind(ctx), undefined, ['unrelated/event'])
    }).not.toThrow()
    await fiber.dispose()
  })
})
