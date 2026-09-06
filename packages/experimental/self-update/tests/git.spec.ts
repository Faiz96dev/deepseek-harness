import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SelfUpdateGit } from '../src/git.ts'
import type { SelfUpdateLogLine } from '../src/types.ts'
import {
  addUpstreamCommit, createRepoFixture, git, makeDirty, setupJobHarness, testConfig,
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

  it('merges a fast-forwardable upstream commit', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)

    await addUpstreamCommit(repo.upstreamRoot, 'second commit')
    const { onLine } = collectingSink()
    await gitOps.fetch(onLine)
    const result = await gitOps.merge(onLine)
    expect(result).toBe('merged')
    const head = await gitOps.currentHead()
    expect(head.subject).toBe('second commit')
  })

  it('aborts a conflicting merge and leaves the working tree clean', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)

    // Diverge: the same file changes on both sides so the merge conflicts.
    await writeFile(join(repo.upstreamRoot, 'README.md'), 'upstream change\n', 'utf8')
    await git(repo.upstreamRoot, ['add', '.'])
    await git(repo.upstreamRoot, ['commit', '-m', 'upstream edits README'])

    await writeFile(join(repo.repoRoot, 'README.md'), 'local change\n', 'utf8')
    await git(repo.repoRoot, ['add', '.'])
    await git(repo.repoRoot, ['commit', '-m', 'local edits README'])

    const { onLine } = collectingSink()
    await gitOps.fetch(onLine)
    const result = await gitOps.merge(onLine)
    expect(result).toBe('conflict')
    expect(await gitOps.isDirty()).toBe(false)

    const status = await git(repo.repoRoot, ['status', '--porcelain'])
    expect(status.trim()).toBe('')
  })

  it('throws when a real conflicted merge exists but --abort itself fails', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)

    await writeFile(join(repo.upstreamRoot, 'README.md'), 'upstream change\n', 'utf8')
    await git(repo.upstreamRoot, ['add', '.'])
    await git(repo.upstreamRoot, ['commit', '-m', 'upstream edits README'])
    await writeFile(join(repo.repoRoot, 'README.md'), 'local change\n', 'utf8')
    await git(repo.repoRoot, ['add', '.'])
    await git(repo.repoRoot, ['commit', '-m', 'local edits README'])

    const { onLine } = collectingSink()
    await gitOps.fetch(onLine)
    await gitOps.merge(onLine)
    // The call above already aborted the conflict, leaving no MERGE_HEAD;
    // re-enter the same conflict directly against real git (bypassing
    // gitOps, whose merge() would abort it again), then hold a stale
    // index.lock so gitOps.merge()'s own --abort fails with real git's
    // "Unable to create .git/index.lock" — the same failure mode
    // `job.spec.ts`'s mocked-throw test exercises at the job layer, proven
    // here against the real subprocess this package issues.
    await git(repo.repoRoot, ['merge', '--no-edit', 'upstream/master']).catch(() => {})
    await access(join(repo.repoRoot, '.git', 'MERGE_HEAD'))
    await writeFile(join(repo.repoRoot, '.git', 'index.lock'), '', 'utf8')
    try {
      await expect(gitOps.merge(onLine)).rejects.toThrow(/git merge --abort exited/)
    } finally {
      await rm(join(repo.repoRoot, '.git', 'index.lock'), { force: true })
      await git(repo.repoRoot, ['merge', '--abort']).catch(() => {})
    }
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
    await gitOps.merge(onLine)
    expect((await gitOps.currentHead()).subject).toBe('second commit')

    await gitOps.resetHard(before.sha, onLine)
    expect((await gitOps.currentHead()).sha).toBe(before.sha)
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

  it('resolves failed, without invoking --abort, when a merge attempt starts no real merge', async () => {
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', logDir: '', branch: 'no-such-branch',
    })
    const gitOps = new SelfUpdateGit(harness.ctx, config)
    // No fetch happened, so `git merge --no-edit upstream/no-such-branch`
    // fails without ever writing MERGE_HEAD; merge() checks for MERGE_HEAD
    // before attempting `--abort`, so this resolves 'failed' rather than
    // running (and failing) an abort against a merge that never started —
    // exercising that check distinctly from an ordinary aborted conflict.
    const { onLine } = collectingSink()
    await expect(gitOps.merge(onLine)).resolves.toBe('failed')
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
