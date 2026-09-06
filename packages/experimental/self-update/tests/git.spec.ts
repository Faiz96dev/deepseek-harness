import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SelfUpdateGit } from '../src/git.ts'
import type { SelfUpdateLogLine } from '../src/types.ts'
import {
  addUpstreamCommit, createRepoFixture, FIXTURE_OVERLAY_PATHS, FIXTURE_OVERLAY_REF, git, makeDirty, setupJobHarness, testConfig,
} from './helpers.ts'
import type { RepoFixture, JobTestHarness } from './helpers.ts'

let repo: RepoFixture | undefined
let harness: JobTestHarness | undefined

afterEach(async () => {
  await harness?.dispose()
  await repo?.dispose()
  repo = undefined
  harness = undefined
})

function collectingSink(): { lines: SelfUpdateLogLine[]; onLine: (line: SelfUpdateLogLine) => void } {
  const lines: SelfUpdateLogLine[] = []
  return { lines, onLine: line => lines.push(line) }
}

describe('SelfUpdateGit against a real repository', () => {
  it('reports a clean tree as not dirty and a written file as dirty', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)

    expect(await gitOps.isDirty()).toBe(false)
    await makeDirty(repo.repoRoot)
    expect(await gitOps.isDirty()).toBe(true)
  })

  it('reads the current HEAD subject and sha', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)

    const head = await gitOps.currentHead()
    expect(head.subject).toBe('initial')
    expect(head.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('fetches and counts commits behind an updated upstream', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)

    await addUpstreamCommit(repo.upstreamRoot, 'second commit')
    const { onLine } = collectingSink()
    await gitOps.fetch(onLine)
    const counts = await gitOps.revCounts()
    expect(counts.behind).toBe(1)
    expect(counts.ahead).toBe(0)
    expect(counts.remoteHead.subject).toBe('second commit')
  })

  it('reports whether a ref exists', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)

    expect(await gitOps.refExists(FIXTURE_OVERLAY_REF)).toBe(true)
    expect(await gitOps.refExists('no-such-ref')).toBe(false)
  })

  it('resets hard to a named commit', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)

    const before = await gitOps.currentHead()
    await addUpstreamCommit(repo.upstreamRoot, 'second commit')
    const { onLine } = collectingSink()
    await gitOps.fetch(onLine)
    const counts = await gitOps.revCounts()
    await gitOps.resetHard(counts.remoteHead.sha, onLine)
    expect((await gitOps.currentHead()).subject).toBe('second commit')

    await gitOps.resetHard(before.sha, onLine)
    expect((await gitOps.currentHead()).sha).toBe(before.sha)
  })

  it('restores paths from another ref onto the working tree and index', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)
    const { onLine } = collectingSink()

    expect(await readFile(join(repo.repoRoot, 'plugins', 'marker.txt'), 'utf8').catch(() => null)).toBeNull()
    await gitOps.restorePaths(FIXTURE_OVERLAY_REF, FIXTURE_OVERLAY_PATHS, onLine)
    expect(await readFile(join(repo.repoRoot, 'plugins', 'marker.txt'), 'utf8')).toBe('plugin content\n')
    const status = await git(repo.repoRoot, ['status', '--porcelain'])
    expect(status.trim()).toBe('A  plugins/marker.txt')
  })

  it('throws when restorePaths names an unknown ref', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)
    const { onLine } = collectingSink()
    await expect(gitOps.restorePaths('no-such-ref', FIXTURE_OVERLAY_PATHS, onLine)).rejects.toThrow(/git checkout no-such-ref/)
  })

  it('stages and commits every working-tree change, bypassing hooks', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)
    const { onLine } = collectingSink()
    const before = await gitOps.currentHead()

    await gitOps.restorePaths(FIXTURE_OVERLAY_REF, FIXTURE_OVERLAY_PATHS, onLine)
    await gitOps.commitAll('self-update: overlay plugin onto test', onLine)

    const after = await gitOps.currentHead()
    expect(after.sha).not.toBe(before.sha)
    expect(after.subject).toBe('self-update: overlay plugin onto test')
    expect(await gitOps.isDirty()).toBe(false)
  })

  it('throws when git add itself fails', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    // Real git's `add -A` essentially never fails on a healthy repository; a
    // fake `git` that fails only for `add` is the only deterministic way to
    // force this branch distinctly from a failed `commit`.
    const binDir = await mkdtemp(join(tmpdir(), 'dsh-self-update-fakebin-'))
    const fakeGit = join(binDir, 'git')
    await writeFile(fakeGit, '#!/bin/sh\nif [ "$1" = "add" ]; then exit 1; fi\nexit 0\n', 'utf8')
    await chmod(fakeGit, 0o755)
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
      extraPathDirs: [binDir],
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)
    const { onLine } = collectingSink()
    try {
      await expect(gitOps.commitAll('message', onLine)).rejects.toThrow(/git add -A exited 1/)
    } finally {
      await rm(binDir, { recursive: true, force: true })
    }
  })

  it('throws when commitAll has nothing to commit', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)
    const { onLine } = collectingSink()
    await expect(gitOps.commitAll('empty', onLine)).rejects.toThrow(/git commit exited/)
  })

  it('throws when fetch names a nonexistent remote branch', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '', branch: 'no-such-branch',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)

    const { onLine } = collectingSink()
    // Real git's own diagnostic (not just the exit code) must reach the
    // thrown message, so a caller sees why the fetch failed, not just that it did.
    await expect(gitOps.fetch(onLine)).rejects.toThrow(/git fetch upstream no-such-branch exited \d+: .*couldn't find remote ref/i)
  })

  it('omits the colon-prefixed detail when the failed fetch produces no output at all', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    // A real `git fetch` always prints a diagnostic on failure; a fake `git`
    // that exits 1 silently is the only way to force the no-output case.
    const binDir = await mkdtemp(join(tmpdir(), 'dsh-self-update-fakebin-'))
    const fakeGit = join(binDir, 'git')
    await writeFile(fakeGit, '#!/bin/sh\nexit 1\n', 'utf8')
    await chmod(fakeGit, 0o755)
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
      extraPathDirs: [binDir],
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)

    const { onLine } = collectingSink()
    try {
      await expect(gitOps.fetch(onLine)).rejects.toThrow(/^git fetch upstream master exited 1$/)
    } finally {
      await rm(binDir, { recursive: true, force: true })
    }
  })

  it('throws when revCounts reads a remote branch name that does not exist', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '', branch: 'no-such-branch',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)

    await expect(gitOps.revCounts()).rejects.toThrow(/git log -1/)
  })

  it('throws when resetHard names an unknown commit', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)
    const { onLine } = collectingSink()
    await expect(gitOps.resetHard('0'.repeat(40), onLine)).rejects.toThrow(/git reset --hard/)
  })
})
