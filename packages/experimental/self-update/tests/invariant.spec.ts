import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as SelfUpdateInvariant from '../src/invariant.ts'
import SelfUpdateService from '../src/index.ts'
import { createRepoFixture, testConfig } from './helpers.ts'
import type { RepoFixture } from './helpers.ts'

let repo: RepoFixture | undefined
let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  await repo?.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  repo = undefined
  root = undefined
})

async function setupHarness(): Promise<Context> {
  repo = await createRepoFixture()
  root = await mkdtemp(join(tmpdir(), 'dsh-self-update-invariant-'))
  const created = new Context()
  await created.plugin(SessionStore)
  await created.plugin(JsonlSessionPersistence, {
    root: join(root, 'sessions'),
    compression: 'none',
    writeBatchMaxDelayMs: 1,
  })
  await created.plugin(LocalSubprocessRuntime)
  await created.plugin(SelfUpdateService, testConfig({
    repoRoot: repo.repoRoot,
    backupRoot: join(root, 'backups'),
    sessionsDir: join(root, 'sessions'),
    storagesDir: join(root, 'storages'),
    attachmentsDir: join(root, 'attachments'),
  }))
  return created
}

describe('self-update invariant companion', () => {
  it('removes its registry contribution when its fiber is disposed (HMR safety)', async () => {
    ctx = await setupHarness()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(SelfUpdateInvariant)

    expect(() => {
      ctx?.invariants.register('@deepseek-ai/dsh-experimental-self-update', () => {})
    }).toThrow(/already registered/u)

    await fiber.dispose()
    await expect(ctx.plugin(SelfUpdateInvariant).await()).resolves.toBeDefined()
  })
})
