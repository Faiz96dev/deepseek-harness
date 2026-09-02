/**
 * Validated deployment configuration for the self-update job.
 * @module @deepseek-ai/dsh-experimental-self-update/config
 */

import s from '@deepseek-ai/schemastery'

/** Required deployment policy for one self-update installation. */
export interface Config {
  /** Absolute path to the git checkout this process runs from. */
  readonly repoRoot: string
  /** Name of the git remote holding the parent repository. */
  readonly remoteName: string
  /** Branch on `remoteName` this checkout tracks. */
  readonly branch: string
  /** Argv that installs dependencies against the merged tree (`argv[0]` is the executable). */
  installArgv: string[]
  /** Argv that rebuilds every artifact this deployment serves. */
  buildArgv: string[]
  /** Argv that must exit 0 against the freshly built tree before restarting into it. */
  verifyArgv: string[]
  /** Directories prepended to PATH before resolving and running every argv above. */
  extraPathDirs: string[]
  /** Directory holding one subdirectory per pre-update Session snapshot. */
  readonly backupRoot: string
  /** Snapshots retained in `backupRoot`; older ones are pruned after a successful backup. */
  readonly keepBackups: number
  /** Durable Session log directory this deployment reads and writes (`dsh-session-persistence-jsonl`'s `root`). */
  readonly sessionsDir: string
  /** Durable KV storage-domain directory (`dsh-storage-json`'s `root`). */
  readonly storagesDir: string
  /** Content-addressed attachment directory (`dsh-attachment-local`'s root). */
  readonly attachmentsDir: string
  /** SIGTERM-to-SIGKILL escalation grace, in milliseconds, for every spawned child. */
  readonly graceMs: number
  /** Bounded per-job in-memory log line count; older lines are dropped once exceeded. */
  readonly maxLogLines: number
}

export const Config: s<Config> = s.object({
  repoRoot: s.string().required(),
  remoteName: s.string().required(),
  branch: s.string().required(),
  installArgv: s.array(s.string()).required(),
  buildArgv: s.array(s.string()).required(),
  verifyArgv: s.array(s.string()).required(),
  extraPathDirs: s.array(s.string()).required(),
  backupRoot: s.string().required(),
  keepBackups: s.number().step(1).min(0).required(),
  sessionsDir: s.string().required(),
  storagesDir: s.string().required(),
  attachmentsDir: s.string().required(),
  graceMs: s.number().step(1).min(1).required(),
  maxLogLines: s.number().step(1).min(1).required(),
})
