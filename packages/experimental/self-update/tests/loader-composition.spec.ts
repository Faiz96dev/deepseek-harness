import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SelfUpdateService from '../src/index.ts'
import { addUpstreamCommit, createRepoFixture, FIXTURE_VERSION, nodeScript } from './helpers.ts'
import type { RepoFixture } from './helpers.ts'

let configRoot: string | undefined
let repo: RepoFixture | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (configRoot !== undefined) await rm(configRoot, { recursive: true, force: true })
  await repo?.dispose()
  configRoot = undefined
  repo = undefined
})

async function loadComposition(configPath: string, onExit: (code: number) => void): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(configRoot as string).href + '/'
  ctx.provide('appExit', onExit)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-experimental-self-update', SelfUpdateService],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  const unloaded = [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  return ctx
}

describe('self-update through a real Loader composition', () => {
  it('reports status and runs a full update through the real plugin tree', async () => {
    repo = await createRepoFixture()
    configRoot = await mkdtemp(join(tmpdir(), 'dsh-self-update-loader-'))
    await mkdir(join(configRoot, 'sessions'), { recursive: true })
    const configPath = join(configRoot, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: ${JSON.stringify(join(configRoot, 'sessions'))}`,
      '    compression: none',
      '    writeBatchMaxDelayMs: 1',
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      "- name: '@deepseek-ai/dsh-experimental-self-update'",
      '  config:',
      `    repoRoot: ${JSON.stringify(repo.repoRoot)}`,
      '    remoteName: upstream',
      '    branch: master',
      `    installArgv: ${JSON.stringify(nodeScript('process.exit(0)'))}`,
      `    buildArgv: ${JSON.stringify(nodeScript('process.exit(0)'))}`,
      `    verifyArgv: ${JSON.stringify(nodeScript('process.exit(0)'))}`,
      '    extraPathDirs: []',
      `    backupRoot: ${JSON.stringify(join(configRoot, 'backups'))}`,
      '    keepBackups: 5',
      `    sessionsDir: ${JSON.stringify(join(configRoot, 'sessions'))}`,
      `    storagesDir: ${JSON.stringify(join(configRoot, 'storages'))}`,
      `    attachmentsDir: ${JSON.stringify(join(configRoot, 'attachments'))}`,
      '    graceMs: 2000',
      '    maxLogLines: 500',
      '',
    ].join('\n'))

    let exitCode: number | undefined
    const ctx = await loadComposition(configPath, (code) => { exitCode = code })
    expect(ctx.selfUpdate.typertRemote.namespace).toBe('selfUpdate')
    expect(remoteMethods(ctx.selfUpdate).map(marker => marker.method))
      .toEqual(['status', 'check', 'start', 'follow'])

    const status = await ctx.selfUpdate.status()
    expect(status.version).toBe(FIXTURE_VERSION)
    expect(status.dirty).toBe(false)
    expect(status.job).toBeNull()

    await addUpstreamCommit(repo.upstreamRoot, 'second commit')

    const started = await ctx.selfUpdate.start({})
    if (!started.ok) throw new Error(`expected start success, got ${started.error.code}`)

    const frames: string[] = []
    const controller = new AbortController()
    for await (const frame of ctx.selfUpdate.follow(controller.signal)) {
      if (frame.type === 'phase') frames.push(frame.phase)
      if (frame.type === 'done') break
    }
    expect(frames).toContain('merging')
    expect(frames).toContain('restarting')
    expect(exitCode).toBe(0)
  })
})
