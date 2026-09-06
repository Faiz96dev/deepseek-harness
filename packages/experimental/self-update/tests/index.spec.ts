import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Config } from '../src/config.ts'
import SelfUpdateService from '../src/index.ts'
import {
  addUpstreamCommit, createRepoFixture, failWhileMarkerPresent, FIXTURE_VERSION, makeDirty, setupJobHarness, testConfig,
} from './helpers.ts'
import type { JobTestHarness, RepoFixture } from './helpers.ts'

let repo: RepoFixture | undefined
let harness: JobTestHarness | undefined

afterEach(async () => {
  await harness?.dispose()
  await repo?.dispose()
  repo = undefined
  harness = undefined
})

interface ServiceHarness {
  repo: RepoFixture
  harness: JobTestHarness
  service: SelfUpdateService
  appExit: ReturnType<typeof vi.fn>
}

async function setup(options: {
  withAppExit?: boolean
  configOverrides?: Partial<Config>
} = {}): Promise<ServiceHarness> {
  repo = await createRepoFixture()
  harness = await setupJobHarness()
  const backupBase = repo.repoRoot.replace(/\/repo$/, '')
  await mkdir(join(backupBase, 'sessions'), { recursive: true })
  const appExit = vi.fn()
  if (options.withAppExit !== false) harness.ctx.provide('appExit', appExit)
  const config = testConfig({
    repoRoot: repo.repoRoot,
    backupRoot: join(backupBase, 'backups'),
    sessionsDir: join(backupBase, 'sessions'),
    storagesDir: join(backupBase, 'storages'),
    attachmentsDir: join(backupBase, 'attachments'),
    logDir: join(backupBase, 'logs'),
    ...options.configOverrides,
  })
  await harness.ctx.plugin(SelfUpdateService, config)
  return { repo, harness, service: harness.ctx.selfUpdate, appExit }
}

describe('SelfUpdateService.status', () => {
  it('reports null behind/ahead and no remoteHead before any check', async () => {
    const ctx = await setup()
    const status = await ctx.service.status()
    expect(status.version).toBe(FIXTURE_VERSION)
    expect(status.behind).toBeNull()
    expect(status.remoteHead).toBeNull()
    expect(status.ahead).toBe(0)
    expect(status.dirty).toBe(false)
    expect(status.job).toBeNull()
    expect(status.lastRun).toBeNull()
  })

  it('reports dirty true once the working tree carries uncommitted changes', async () => {
    const ctx = await setup()
    await makeDirty(ctx.repo.repoRoot)
    expect((await ctx.service.status()).dirty).toBe(true)
  })

  it('fails loud when repoRoot carries no package.json', async () => {
    const ctx = await setup()
    await rm(join(ctx.repo.repoRoot, 'package.json'))
    await expect(ctx.service.status()).rejects.toThrow(/ENOENT/)
  })

  it('fails loud when the root package.json declares no string version', async () => {
    const ctx = await setup()
    await writeFile(join(ctx.repo.repoRoot, 'package.json'), JSON.stringify({ name: 'fixture', version: 3 }), 'utf8')
    await expect(ctx.service.status()).rejects.toThrow(/must declare a non-empty string "version"/)
  })

  it('fails loud when the root package.json is valid JSON but not an object', async () => {
    const ctx = await setup()
    await writeFile(join(ctx.repo.repoRoot, 'package.json'), 'null\n', 'utf8')
    await expect(ctx.service.status()).rejects.toThrow(/must declare a non-empty string "version"/)
  })
})

describe('SelfUpdateService.start logging', () => {
  it('writes every refused start with its reason to the Host logger', async () => {
    const ctx = await setup()
    await makeDirty(ctx.repo.repoRoot)
    const warn = vi.spyOn(ctx.harness.ctx.logger, 'warn')
    await ctx.service.start()
    expect(warn).toHaveBeenCalledWith('self-update: start refused: {"code":"dirty-working-tree"}')
  })
})

describe('SelfUpdateService load', () => {
  it('creates logDir at load and fails loud when it cannot be created', async () => {
    const ctx = await setup()
    const backupBase = ctx.repo.repoRoot.replace(/\/repo$/, '')
    expect((await stat(join(backupBase, 'logs'))).isDirectory()).toBe(true)

    const blocker = join(backupBase, 'blocker')
    await writeFile(blocker, 'a regular file where a directory is needed\n', 'utf8')
    const config = testConfig({
      repoRoot: ctx.repo.repoRoot,
      backupRoot: join(backupBase, 'backups'),
      sessionsDir: join(backupBase, 'sessions'),
      storagesDir: join(backupBase, 'storages'),
      attachmentsDir: join(backupBase, 'attachments'),
      logDir: join(blocker, 'logs'),
    })
    expect(() => new SelfUpdateService(new Context(), config)).toThrow(/ENOTDIR|EEXIST/)
  })
})

describe('SelfUpdateService.check', () => {
  it('fetches upstream and reports behind/remoteHead, then status reflects it without fetching again', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    const checked = await ctx.service.check()
    expect(checked.behind).toBe(1)
    expect(checked.remoteHead?.subject).toBe('second commit')

    const status = await ctx.service.status()
    expect(status.behind).toBe(1)
    expect(status.remoteHead?.subject).toBe('second commit')
  })
})

describe('SelfUpdateService.start', () => {
  it('refuses when the working tree is dirty', async () => {
    const ctx = await setup()
    await makeDirty(ctx.repo.repoRoot)
    const result = await ctx.service.start()
    expect(result).toEqual({ ok: false, error: { code: 'dirty-working-tree' } })
  })

  it('refuses when no bounded exit request is available', async () => {
    const ctx = await setup({ withAppExit: false })
    const result = await ctx.service.start()
    expect(result).toEqual({ ok: false, error: { code: 'app-exit-unavailable' } })
  })

  it('refuses a second start while a job is still running, but accepts one once the first has finished', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')

    const first = await ctx.service.start()
    expect(first.ok).toBe(true)
    const second = await ctx.service.start()
    expect(second).toEqual({ ok: false, error: { code: 'job-already-running' } })

    await vi.waitFor(() => { expect(ctx.appExit).toHaveBeenCalledWith(0) })

    await addUpstreamCommit(ctx.repo.upstreamRoot, 'third commit')
    const third = await ctx.service.start()
    expect(third.ok).toBe(true)
    // Let the third job settle (and stop writing its log file) before
    // afterEach removes the fixture directory that file lives in.
    await vi.waitFor(() => { expect(ctx.appExit).toHaveBeenCalledTimes(2) })
  })

  it('flushes every live Session before starting a job, without asking about them', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    const session = ctx.harness.ctx.sessions.create()
    const flushed: string[] = []
    ctx.harness.ctx.on('session/flush', (flushedSession) => { flushed.push(flushedSession.id) })

    const started = await ctx.service.start()
    expect(started.ok).toBe(true)
    expect(flushed).toContain(session.id)
    // Let the job settle before teardown removes the fixture it is still logging into.
    await vi.waitFor(() => { expect(ctx.appExit).toHaveBeenCalled() })
  })

  it('records lastRun once the started job settles', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    await ctx.service.start()
    await vi.waitFor(() => { expect(ctx.appExit).toHaveBeenCalled() })
    const status = await ctx.service.status()
    expect(status.lastRun?.outcome).toBe('succeeded')
  })

  it('reports rolled-back through status.lastRun when the build fails', async () => {
    const ctx = await setup({
      configOverrides: { buildArgv: failWhileMarkerPresent('second-commit.txt') },
    })
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')

    await ctx.service.start()
    await vi.waitFor(async () => {
      const status = await ctx.service.status()
      expect(status.lastRun).not.toBeNull()
    })
    expect(ctx.appExit).not.toHaveBeenCalled()
    const status = await ctx.service.status()
    expect(status.lastRun?.outcome).toBe('rolled-back')
  })
})

describe('SelfUpdateService.follow', () => {
  it('yields exactly an idle baseline with an empty log when no job has ever run, then ends', async () => {
    const ctx = await setup()
    const controller = new AbortController()
    const frames: unknown[] = []
    for await (const frame of ctx.service.follow(controller.signal)) {
      frames.push(frame)
    }
    expect(frames).toEqual([{ type: 'baseline', status: await ctx.service.status(), log: [] }])
  })

  it('yields a baseline with the current job plus live increments once one has started', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    await ctx.service.start()

    const controller = new AbortController()
    const frames: { type: string }[] = []
    for await (const frame of ctx.service.follow(controller.signal)) {
      frames.push(frame)
      if (frame.type === 'done') break
    }
    expect(frames[0]?.type).toBe('baseline')
    expect(frames.some(f => f.type === 'phase')).toBe(true)
    expect(frames.at(-1)?.type).toBe('done')
  })
})
