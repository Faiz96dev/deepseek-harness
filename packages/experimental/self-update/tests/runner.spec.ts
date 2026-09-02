import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runStreaming } from '../src/runner.ts'
import type { SelfUpdateLogLine } from '../src/types.ts'
import { createRepoFixture, nodeScript, setupJobHarness, testConfig } from './helpers.ts'
import type { JobTestHarness, RepoFixture } from './helpers.ts'

let repo: RepoFixture | undefined
let harness: JobTestHarness | undefined

afterEach(async () => {
  await harness?.dispose()
  await repo?.dispose()
  repo = undefined
  harness = undefined
})

async function setup() {
  repo = await createRepoFixture()
  harness = await setupJobHarness()
  const config = testConfig({
    repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '',
  })
  return { repo, harness, config }
}

describe('runStreaming', () => {
  it('throws when argv is empty', async () => {
    const ctx = await setup()
    await expect(runStreaming(ctx.harness.ctx, ctx.config, [], 'preflight', () => {}))
      .rejects.toThrow(/argv must name an executable/)
  })

  it('flushes a final unterminated line and skips flushing when the stream ends on a newline', async () => {
    const ctx = await setup()
    const linesNoTrailingNewline: SelfUpdateLogLine[] = []
    await runStreaming(
      ctx.harness.ctx, ctx.config,
      nodeScript("process.stdout.write('no trailing newline')"),
      'preflight',
      line => linesNoTrailingNewline.push(line),
    )
    expect(linesNoTrailingNewline.map(l => l.text)).toEqual(['no trailing newline'])

    const linesTrailingNewline: SelfUpdateLogLine[] = []
    await runStreaming(
      ctx.harness.ctx, ctx.config,
      nodeScript("process.stdout.write('with trailing newline\\n')"),
      'preflight',
      line => linesTrailingNewline.push(line),
    )
    expect(linesTrailingNewline.map(l => l.text)).toEqual(['with trailing newline'])
  })

  it('skips emitting a decoded empty line', async () => {
    const ctx = await setup()
    const lines: SelfUpdateLogLine[] = []
    await runStreaming(
      ctx.harness.ctx, ctx.config,
      nodeScript("process.stdout.write('one\\n\\ntwo\\n')"),
      'preflight',
      line => lines.push(line),
    )
    expect(lines.map(l => l.text)).toEqual(['one', 'two'])
  })

  it('flushes a final unterminated stderr line', async () => {
    const ctx = await setup()
    const lines: SelfUpdateLogLine[] = []
    await runStreaming(
      ctx.harness.ctx, ctx.config,
      nodeScript("process.stderr.write('stderr with no trailing newline')"),
      'preflight',
      line => lines.push(line),
    )
    expect(lines.map(l => l.text)).toEqual(['stderr with no trailing newline'])
  })

  it('tags every emitted line with the requested phase and stream', async () => {
    const ctx = await setup()
    const lines: SelfUpdateLogLine[] = []
    await runStreaming(
      ctx.harness.ctx, ctx.config,
      nodeScript("process.stdout.write('out\\n'); process.stderr.write('err\\n')"),
      'building',
      line => lines.push(line),
    )
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'building', stream: 'stdout', text: 'out' }),
      expect.objectContaining({ phase: 'building', stream: 'stderr', text: 'err' }),
    ]))
  })

  it('resolves with the process exit code', async () => {
    const ctx = await setup()
    const outcome = await runStreaming(ctx.harness.ctx, ctx.config, nodeScript('process.exit(3)'), 'preflight', () => {})
    expect(outcome.exitCode).toBe(3)
  })

  it('still resolves the executable when the ambient PATH is unset, via extraPathDirs', async () => {
    const nodeDir = dirname(process.execPath)
    repo = await createRepoFixture()
    harness = await setupJobHarness()
    const config = testConfig({
      repoRoot: repo.repoRoot, backupRoot: '', sessionsDir: '', storagesDir: '', attachmentsDir: '', extraPathDirs: [nodeDir],
    })
    vi.stubEnv('PATH', undefined)
    try {
      const outcome = await runStreaming(harness.ctx, config, nodeScript('process.exit(0)'), 'preflight', () => {})
      expect(outcome.exitCode).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
