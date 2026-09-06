import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackup } from '../src/backup.ts'
import { testConfig } from './helpers.ts'
import type { SelfUpdateCommit } from '../src/types.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const commit: SelfUpdateCommit = { sha: 'a'.repeat(40), subject: 'pre-update' }

describe('createBackup', () => {
  it('copies existing session-adjacent directories and writes a manifest', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-self-update-backup-'))
    const sessionsDir = join(root, 'sessions')
    const storagesDir = join(root, 'storages')
    const attachmentsDir = join(root, 'attachments')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(join(sessionsDir, 'a.jsonl'), 'log\n', 'utf8')
    await mkdir(storagesDir, { recursive: true })
    await writeFile(join(storagesDir, 'b.json'), '{}', 'utf8')
    // attachmentsDir deliberately left absent.

    const config = testConfig({
      repoRoot: '', backupRoot: join(root, 'backups'), sessionsDir, storagesDir, attachmentsDir, logDir: '', keepBackups: 5,
    })
    const backupPath = await createBackup(config, commit)

    expect(await readFile(join(backupPath, 'sessions', 'a.jsonl'), 'utf8')).toBe('log\n')
    expect(await readFile(join(backupPath, 'storages', 'b.json'), 'utf8')).toBe('{}')
    const manifest = JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8')) as { fromCommit: SelfUpdateCommit }
    expect(manifest.fromCommit).toEqual(commit)

    const attachmentsCopy = await readdir(backupPath).catch(() => [])
    expect(attachmentsCopy).not.toContain('attachments')
  })

  it('prunes snapshots beyond keepBackups, oldest first', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-self-update-backup-'))
    const backupRoot = join(root, 'backups')
    const config = testConfig({
      repoRoot: '', backupRoot, sessionsDir: join(root, 'sessions'), storagesDir: join(root, 'storages'), attachmentsDir: join(root, 'attachments'), logDir: '', keepBackups: 2,
    })

    const paths: string[] = []
    for (let i = 0; i < 4; i++) {
      paths.push(await createBackup(config, { sha: `${i}`.repeat(40), subject: `commit ${i}` }))
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    const remaining = await readdir(backupRoot)
    expect(remaining).toHaveLength(2)
    const remainingSet = new Set(remaining)
    expect(remainingSet.has(paths[2]?.split('/').pop() as string)).toBe(true)
    expect(remainingSet.has(paths[3]?.split('/').pop() as string)).toBe(true)
  })
})
