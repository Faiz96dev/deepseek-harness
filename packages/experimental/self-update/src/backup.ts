/**
 * Pre-update snapshot of every durable Session-adjacent directory. This is a
 * disaster-recovery artifact for a human operator, not part of the automated
 * rollback path: `git reset`/`git checkout`/`installArgv`/`buildArgv` never touch these
 * directories (they live under `$DSH_HOME`, outside the git checkout), so the
 * automated rollback only ever reverts the git tree.
 * @module @deepseek-ai/dsh-experimental-self-update/backup
 */

import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config.ts'
import type { SelfUpdateCommit } from './types.ts'

/** One completed backup's manifest, written alongside the copied directories. */
export interface SelfUpdateBackupManifest {
  readonly createdAt: number
  readonly fromCommit: SelfUpdateCommit
}

/**
 * Copy `sessionsDir`, `storagesDir`, and `attachmentsDir` into a fresh
 * timestamped subdirectory of `backupRoot`, write a manifest naming the
 * pre-update commit, then prune snapshots beyond `keepBackups`.
 * @param config - deployment paths and retention policy.
 * @param fromCommit - commit HEAD is at before this update begins.
 * @returns the absolute path to the new backup directory.
 */
export async function createBackup(config: Config, fromCommit: SelfUpdateCommit): Promise<string> {
  const stamp = new Date().toISOString().replaceAll(':', '-')
  const shortSha = fromCommit.sha.slice(0, 7)
  const backupDir = join(config.backupRoot, `${stamp}-${shortSha}`)
  await mkdir(backupDir, { recursive: true })

  await copyIfExists(config.sessionsDir, join(backupDir, 'sessions'))
  await copyIfExists(config.storagesDir, join(backupDir, 'storages'))
  await copyIfExists(config.attachmentsDir, join(backupDir, 'attachments'))

  const manifest: SelfUpdateBackupManifest = { createdAt: Date.now(), fromCommit }
  await writeFile(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  await pruneOldBackups(config.backupRoot, config.keepBackups)
  return backupDir
}

async function copyIfExists(source: string, destination: string): Promise<void> {
  try {
    await stat(source)
  } catch {
    // Absent source directory (e.g. no attachments were ever written): there
    // is nothing to snapshot, and creating an empty destination would only
    // misrepresent this backup as covering data that never existed.
    return
  }
  await cp(source, destination, { recursive: true })
}

async function pruneOldBackups(backupRoot: string, keepBackups: number): Promise<void> {
  let entries: string[]
  try {
    entries = (await readdir(backupRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    // createBackup always creates backupRoot (via this backup's own mkdir)
    // before calling this function, so this only guards a concurrent
    // external deletion between that mkdir and this read.
    /* v8 ignore next -- exercising a concurrent external deletion is not a reproducible unit-test scenario. */
    return
  }
  const excess = entries.length - keepBackups
  if (excess <= 0) return
  for (const name of entries.slice(0, excess)) {
    await rm(join(backupRoot, name), { recursive: true, force: true })
  }
}
