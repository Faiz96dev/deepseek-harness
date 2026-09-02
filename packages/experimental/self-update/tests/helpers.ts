import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Config } from '../src/config.ts'

/** Run one git command against `cwd`, throwing on a non-zero exit. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { stdout } = await run('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout
}

/** One temporary "upstream" repository plus a clone tracking it as `origin`. */
export interface RepoFixture {
  readonly upstreamRoot: string
  readonly repoRoot: string
  dispose(): Promise<void>
}

/** The `version` committed into every fixture repository's root `package.json`. */
export const FIXTURE_VERSION = '1.2.3'

/**
 * Build a local checkout (`repoRoot`) with a real `upstream` remote pointing
 * at a second, independent repository (`upstreamRoot`) — real git operating
 * on real temporary directories, no mocked subprocess. The initial commit
 * carries a root `package.json` declaring {@link FIXTURE_VERSION}, as the
 * service reads the deployment version from there.
 */
export async function createRepoFixture(): Promise<RepoFixture> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-self-update-repo-'))
  const upstreamRoot = join(base, 'upstream')
  const repoRoot = join(base, 'repo')
  await mkdir(upstreamRoot, { recursive: true })
  await git(upstreamRoot, ['init', '--initial-branch=master'])
  await writeFile(join(upstreamRoot, 'README.md'), 'initial\n', 'utf8')
  await writeFile(
    join(upstreamRoot, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, version: FIXTURE_VERSION }, null, 2)}\n`,
    'utf8',
  )
  await git(upstreamRoot, ['add', '.'])
  await git(upstreamRoot, ['commit', '-m', 'initial'])

  await git(base, ['clone', upstreamRoot, repoRoot])
  await git(repoRoot, ['remote', 'rename', 'origin', 'upstream'])

  return {
    upstreamRoot,
    repoRoot,
    async dispose() {
      await rm(base, { recursive: true, force: true })
    },
  }
}

/** Append one commit to `upstreamRoot` so the local checkout falls behind. */
export async function addUpstreamCommit(upstreamRoot: string, message: string, fileContent = message): Promise<void> {
  await writeFile(join(upstreamRoot, `${message.replaceAll(/\s+/g, '-')}.txt`), fileContent, 'utf8')
  await git(upstreamRoot, ['add', '.'])
  await git(upstreamRoot, ['commit', '-m', message])
}

/** Write one uncommitted change into `repoRoot`. */
export async function makeDirty(repoRoot: string): Promise<void> {
  await writeFile(join(repoRoot, 'dirty.txt'), 'uncommitted\n', 'utf8')
}

/** A script argv pair: a `node -e` invocation with an inline body. */
export function nodeScript(body: string): string[] {
  return ['node', '-e', body]
}

/**
 * A build/verify script that fails only while `relativeMarkerPath` exists in
 * the current working directory (the merged, not-yet-reverted tree) and
 * succeeds once it is gone (after a rollback's `git reset --hard`) — so a
 * rollback rehearsal exercises a real state-dependent build rather than one
 * that fails unconditionally regardless of which commit is checked out.
 */
export function failWhileMarkerPresent(relativeMarkerPath: string): string[] {
  return nodeScript(
    `process.exit(require('node:fs').existsSync(${JSON.stringify(relativeMarkerPath)}) ? 1 : 0)`,
  )
}

/** The required-per-test fields `testConfig` cannot default. */
type RequiredTestConfig = Pick<Config, 'repoRoot' | 'backupRoot' | 'sessionsDir' | 'storagesDir' | 'attachmentsDir'>

/** Complete self-update `Config` for one test, with sensible bounded defaults. */
export function testConfig(overrides: Partial<Config> & RequiredTestConfig): Config {
  return {
    remoteName: 'upstream',
    branch: 'master',
    installArgv: nodeScript('process.exit(0)'),
    buildArgv: nodeScript('process.exit(0)'),
    verifyArgv: nodeScript('process.exit(0)'),
    extraPathDirs: [],
    keepBackups: 5,
    graceMs: 2000,
    maxLogLines: 500,
    ...overrides,
  }
}

export interface JobTestHarness {
  readonly ctx: Context
  dispose(): Promise<void>
}

/** Compose a real Context with SessionStore and the local subprocess provider. */
export async function setupJobHarness(): Promise<JobTestHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  return {
    ctx,
    async dispose() {
      await ctx.fiber.dispose()
    },
  }
}
