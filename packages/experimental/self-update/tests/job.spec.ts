import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelfUpdateGit } from '../src/git.ts'
import { isTerminal, SelfUpdateJob } from '../src/job.ts'
import type { SelfUpdateFollowFrame } from '../src/types.ts'
import {
  addUpstreamCommit, createRepoFixture, failWhileMarkerPresent, git, makeDirty, nodeScript, setupJobHarness, testConfig,
} from './helpers.ts'
import type { JobTestHarness, RepoFixture } from './helpers.ts'

let repo: RepoFixture | undefined
let harness: JobTestHarness | undefined
let backupBase: string | undefined

afterEach(async () => {
  await harness?.dispose()
  await repo?.dispose()
  if (backupBase !== undefined) await rm(backupBase, { recursive: true, force: true })
  repo = undefined
  harness = undefined
  backupBase = undefined
})

async function setup(): Promise<{ repo: RepoFixture; harness: JobTestHarness; git: SelfUpdateGit; backupBase: string }> {
  repo = await createRepoFixture()
  harness = await setupJobHarness()
  backupBase = await mkdtemp(join(tmpdir(), 'dsh-self-update-job-'))
  await mkdir(join(backupBase, 'sessions'), { recursive: true })
  await mkdir(join(backupBase, 'storages'), { recursive: true })
  // The service creates logDir at load; jobs constructed directly here need it in place.
  await mkdir(join(backupBase, 'logs'), { recursive: true })
  return { repo, harness, git: new SelfUpdateGit(harness.ctx, testConfigFor(repo, backupBase)), backupBase }
}

type TestConfigInput = Parameters<typeof testConfig>[0]

/** Complete config for one fixture; `logDir` defaults to the fixture's `logs` directory unless `extra` names one. */
function testConfigFor(
  fixture: RepoFixture,
  backupBase: string,
  extra: Omit<TestConfigInput, 'logDir'> & { logDir?: string } = {
    repoRoot: fixture.repoRoot,
    backupRoot: join(backupBase, 'backups'),
    sessionsDir: join(backupBase, 'sessions'),
    storagesDir: join(backupBase, 'storages'),
    attachmentsDir: join(backupBase, 'attachments'),
  },
) {
  return testConfig({ logDir: join(backupBase, 'logs'), ...extra })
}

async function drain(job: SelfUpdateJob): Promise<SelfUpdateFollowFrame[]> {
  const controller = new AbortController()
  const frames: SelfUpdateFollowFrame[] = []
  for await (const frame of job.followIncrements(controller.signal)) {
    frames.push(frame)
    if (frame.type === 'done') break
  }
  return frames
}

describe('SelfUpdateJob', () => {
  it('reports up-to-date and performs no merge/install/build when nothing is behind', async () => {
    const ctx = await setup()
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase)
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: ctx.git, config, appExit })

    const frames = await drain(job)
    expect(job.snapshot.outcome).toBe('up-to-date')
    expect(job.snapshot.backupPath).toBeNull()
    expect(appExit).not.toHaveBeenCalled()
    expect(frames.some(f => f.type === 'phase' && f.phase === 'backing-up')).toBe(false)
    expect(frames.some(f => f.type === 'phase' && f.phase === 'installing')).toBe(false)
  })

  it('appends every phase, subprocess line, and the outcome to its own durable log file', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase, {
      repoRoot: ctx.repo.repoRoot,
      backupRoot: join(ctx.backupBase, 'backups'),
      sessionsDir: join(ctx.backupBase, 'sessions'),
      storagesDir: join(ctx.backupBase, 'storages'),
      attachmentsDir: join(ctx.backupBase, 'attachments'),
      logDir: join(ctx.backupBase, 'logs'),
      buildArgv: nodeScript('console.log("building now"); process.exit(0)'),
    })
    await mkdir(config.logDir, { recursive: true })
    const info = vi.spyOn(ctx.harness.ctx.logger, 'info')
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: ctx.git, config, appExit })

    await drain(job)
    expect(job.logPath.startsWith(config.logDir)).toBe(true)
    const text = await readFile(job.logPath, 'utf8')
    expect(text).toContain(`job ${job.snapshot.id} started`)
    expect(text).toMatch(/ phase fetching$/m)
    expect(text).toMatch(/ phase restarting$/m)
    expect(text).toMatch(/\[building\] \[stdout\] building now$/m)
    expect(text).toMatch(/ outcome succeeded$/m)
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/self-update \[[0-9a-f]{8}\] phase merging/))
  })

  it('reports a lost log file once through the Host logger and still completes the job', async () => {
    const ctx = await setup()
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase, {
      repoRoot: ctx.repo.repoRoot,
      backupRoot: join(ctx.backupBase, 'backups'),
      sessionsDir: join(ctx.backupBase, 'sessions'),
      storagesDir: join(ctx.backupBase, 'storages'),
      attachmentsDir: join(ctx.backupBase, 'attachments'),
      // The service creates logDir at load; a directory removed afterwards
      // is the runtime loss this exercises, so it is deliberately not created.
      logDir: join(ctx.backupBase, 'missing', 'logs'),
    })
    const warn = vi.spyOn(ctx.harness.ctx.logger, 'warn')
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: ctx.git, config, appExit })

    await drain(job)
    expect(job.snapshot.outcome).toBe('up-to-date')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/log file .* unavailable.*ENOENT/))
  })

  it('fails preflight on a dirty working tree without touching git or appExit', async () => {
    const ctx = await setup()
    await makeDirty(ctx.repo.repoRoot)
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase)
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: ctx.git, config, appExit })

    await drain(job)
    expect(job.snapshot.outcome).toBe('failed')
    expect(job.snapshot.failure).toEqual({ code: 'dirty-working-tree' })
    expect(appExit).not.toHaveBeenCalled()
  })

  it('runs the full happy path through restart when installArgv/buildArgv/verifyArgv succeed', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase)
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: ctx.git, config, appExit })

    const frames = await drain(job)
    const phases = frames.filter(f => f.type === 'phase').map(f => (f as { phase: string }).phase)
    expect(phases).toEqual(['fetching', 'backing-up', 'merging', 'installing', 'building', 'verifying', 'restarting'])
    expect(job.snapshot.outcome).toBe('succeeded')
    expect(job.snapshot.backupPath).not.toBeNull()

    const head = await ctx.git.currentHead()
    expect(head.subject).toBe('second commit')

    await vi.waitFor(() => { expect(appExit).toHaveBeenCalledWith(0) })
  })

  it('rolls back to the pre-update commit when build fails, and reports build-failed', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    const before = await ctx.git.currentHead()
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase, {
      repoRoot: ctx.repo.repoRoot,
      backupRoot: join(ctx.backupBase, 'backups'),
      sessionsDir: join(ctx.backupBase, 'sessions'),
      storagesDir: join(ctx.backupBase, 'storages'),
      attachmentsDir: join(ctx.backupBase, 'attachments'),
      // Fails only on the merged tree (which carries this marker file); the
      // reverted pre-update commit does not, so the rollback's own rebuild
      // genuinely succeeds instead of failing unconditionally either way.
      buildArgv: failWhileMarkerPresent('second-commit.txt'),
    })
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: ctx.git, config, appExit })

    await drain(job)
    expect(job.snapshot.outcome).toBe('rolled-back')
    expect(job.snapshot.failure).toMatchObject({ code: 'build-failed' })
    expect(appExit).not.toHaveBeenCalled()

    const head = await ctx.git.currentHead()
    expect(head.sha).toBe(before.sha)
  })

  it('reports rollback-failed distinctly when the reverted rebuild also fails', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase, {
      repoRoot: ctx.repo.repoRoot,
      backupRoot: join(ctx.backupBase, 'backups'),
      sessionsDir: join(ctx.backupBase, 'sessions'),
      storagesDir: join(ctx.backupBase, 'storages'),
      attachmentsDir: join(ctx.backupBase, 'attachments'),
      buildArgv: nodeScript('process.exit(1)'),
      installArgv: nodeScript('process.exit(1)'),
    })
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: ctx.git, config, appExit })

    await drain(job)
    expect(job.snapshot.outcome).toBe('rolled-back')
    expect(job.snapshot.failure).toMatchObject({ code: 'rollback-failed' })
  })

  it('aborts a conflicting merge and reports merge-conflict with a clean working tree', async () => {
    const ctx = await setup()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(ctx.repo.upstreamRoot, 'README.md'), 'upstream change\n', 'utf8')
    await git(ctx.repo.upstreamRoot, ['add', '.'])
    await git(ctx.repo.upstreamRoot, ['commit', '-m', 'upstream edits README'])
    await writeFile(join(ctx.repo.repoRoot, 'README.md'), 'local change\n', 'utf8')
    await git(ctx.repo.repoRoot, ['add', '.'])
    await git(ctx.repo.repoRoot, ['commit', '-m', 'local edits README'])

    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase)
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: ctx.git, config, appExit })

    await drain(job)
    expect(job.snapshot.outcome).toBe('failed')
    expect(job.snapshot.failure).toMatchObject({ code: 'merge-conflict' })
    expect(await ctx.git.isDirty()).toBe(false)
  })

  it('reports merge-unrecoverable when the merge call itself throws (merge and its own --abort both failed)', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase)
    // git.spec.ts exercises SelfUpdateGit.merge's own abort-failure path
    // against real git; this test isolates the job's handling of that thrown
    // error (a *conflicted* merge whose own --abort then also fails, unlike
    // merge-failed below, which never has a conflicted merge to abort).
    const throwingGit: SelfUpdateGit = new Proxy(ctx.git, {
      get(target, prop, receiver): unknown {
        if (prop === 'merge') return async () => { throw new Error('git merge --abort exited 1') }
        return Reflect.get(target, prop, receiver)
      },
    })
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: throwingGit, config, appExit })

    await drain(job)
    expect(job.snapshot.outcome).toBe('failed')
    expect(job.snapshot.failure).toMatchObject({ code: 'merge-unrecoverable' })
    expect(appExit).not.toHaveBeenCalled()
  })

  it('reports merge-failed, without touching the working tree, when merge exits non-zero but never starts a conflicted merge', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase)
    // Mirrors what real git reports for a fast-forward-eligible merge that
    // fails transiently (no MERGE_HEAD ever written): SelfUpdateGit.merge
    // resolves 'failed' rather than throwing, since there is nothing to abort
    // and nothing to roll back.
    const failingGit: SelfUpdateGit = new Proxy(ctx.git, {
      get(target, prop, receiver): unknown {
        if (prop === 'merge') return async () => 'failed'
        return Reflect.get(target, prop, receiver)
      },
    })
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: failingGit, config, appExit })

    await drain(job)
    expect(job.snapshot.outcome).toBe('failed')
    expect(job.snapshot.failure).toMatchObject({ code: 'merge-failed' })
    expect(await ctx.git.isDirty()).toBe(false)
    expect(appExit).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error thrown value into the reported failure message', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase)
    const throwingGit: SelfUpdateGit = new Proxy(ctx.git, {
      get(target, prop, receiver): unknown {
        if (prop === 'merge') {
          return async () => { throw 'not an Error instance' }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: throwingGit, config, appExit })

    await drain(job)
    expect(job.snapshot.failure).toMatchObject({ code: 'merge-unrecoverable', message: 'not an Error instance' })
  })

  it('wraps a bare error from preflight itself (not one of its own business checks) as merge-unrecoverable', async () => {
    const ctx = await setup()
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase)
    // isDirty()/appExit are the only checks preflight throws its own
    // SelfUpdateBusinessError for; currentHead() failing is the one bare,
    // unwrapped throw preflight can still surface, exercising toFailure's
    // last-resort branch for a throw that reached it unwrapped.
    const throwingGit: SelfUpdateGit = new Proxy(ctx.git, {
      get(target, prop, receiver): unknown {
        if (prop === 'currentHead') return async () => { throw new Error('git log failed') }
        return Reflect.get(target, prop, receiver)
      },
    })
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: throwingGit, config, appExit })

    await drain(job)
    expect(job.snapshot.outcome).toBe('failed')
    expect(job.snapshot.failure).toEqual({ code: 'merge-unrecoverable', message: 'git log failed' })
    expect(appExit).not.toHaveBeenCalled()
  })

  it('reports fetch-failed when the configured branch does not exist upstream', async () => {
    const ctx = await setup()
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase, {
      repoRoot: ctx.repo.repoRoot,
      backupRoot: join(ctx.backupBase, 'backups'),
      sessionsDir: join(ctx.backupBase, 'sessions'),
      storagesDir: join(ctx.backupBase, 'storages'),
      attachmentsDir: join(ctx.backupBase, 'attachments'),
      branch: 'no-such-branch',
    })
    // SelfUpdateGit captures `config` at construction, so the job's own git
    // operations must be built from the same overridden config it runs with.
    const gitOps = new SelfUpdateGit(ctx.harness.ctx, config)
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: gitOps, config, appExit })

    await drain(job)
    expect(job.snapshot.outcome).toBe('failed')
    expect(job.snapshot.failure).toMatchObject({ code: 'fetch-failed' })
    expect(appExit).not.toHaveBeenCalled()
  })

  it('reports backup-failed when the backup directory cannot be created', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    const appExit = vi.fn()
    // A file (not a directory) in backupRoot's place makes mkdir(recursive)
    // fail with ENOTDIR when createBackup tries to create its subdirectory.
    const { writeFile } = await import('node:fs/promises')
    const blockedBackupRoot = join(ctx.backupBase, 'blocked-backup-root')
    await writeFile(blockedBackupRoot, 'not a directory', 'utf8')
    const config = testConfigFor(ctx.repo, ctx.backupBase, {
      repoRoot: ctx.repo.repoRoot,
      backupRoot: join(blockedBackupRoot, 'nested'),
      sessionsDir: join(ctx.backupBase, 'sessions'),
      storagesDir: join(ctx.backupBase, 'storages'),
      attachmentsDir: join(ctx.backupBase, 'attachments'),
    })
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: ctx.git, config, appExit })

    await drain(job)
    expect(job.snapshot.outcome).toBe('failed')
    expect(job.snapshot.failure).toMatchObject({ code: 'backup-failed' })
    expect(appExit).not.toHaveBeenCalled()
  })

  it('truncates the retained log at maxLogLines', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    const appExit = vi.fn()
    const manyLines = Array.from({ length: 50 }, (_, i) => `console.log(${i})`).join(';')
    const config = testConfigFor(ctx.repo, ctx.backupBase, {
      repoRoot: ctx.repo.repoRoot,
      backupRoot: join(ctx.backupBase, 'backups'),
      sessionsDir: join(ctx.backupBase, 'sessions'),
      storagesDir: join(ctx.backupBase, 'storages'),
      attachmentsDir: join(ctx.backupBase, 'attachments'),
      installArgv: nodeScript(manyLines),
      maxLogLines: 10,
    })
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: ctx.git, config, appExit })

    await drain(job)
    expect(job.retainedLog.length).toBeLessThanOrEqual(10)
  })

  it('fails preflight with no side effects when no bounded exit request is available', async () => {
    const ctx = await setup()
    await addUpstreamCommit(ctx.repo.upstreamRoot, 'second commit')
    const config = testConfigFor(ctx.repo, ctx.backupBase)
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: ctx.git, config, appExit: undefined })

    await drain(job)
    expect(job.snapshot.outcome).toBe('failed')
    expect(job.snapshot.failure).toEqual({ code: 'app-exit-unavailable' })
    // Preflight fails before fetch: local HEAD stays exactly where it started.
    expect((await ctx.git.currentHead()).subject).toBe('initial')
  })

  it('ends the follow stream naturally once the job closes it, without the consumer breaking early', async () => {
    const ctx = await setup()
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase)
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: ctx.git, config, appExit })

    const controller = new AbortController()
    const frames: SelfUpdateFollowFrame[] = []
    for await (const frame of job.followIncrements(controller.signal)) {
      frames.push(frame)
    }
    expect(frames.at(-1)?.type).toBe('done')
    expect(job.snapshot.outcome).toBe('up-to-date')
  })
})

describe('isTerminal', () => {
  it('is false while a job has not finished and true once it has', async () => {
    const ctx = await setup()
    const appExit = vi.fn()
    const config = testConfigFor(ctx.repo, ctx.backupBase)
    const job = SelfUpdateJob.start({ ctx: ctx.harness.ctx, git: ctx.git, config, appExit })
    await drain(job)
    expect(isTerminal(job.snapshot)).toBe(true)
  })
})
