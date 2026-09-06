/**
 * Durable per-job log file under `config.logDir`: every phase transition,
 * subprocess line, system note, and the final outcome, appended
 * synchronously so the record is complete on disk before the process exit
 * that ends a successful job.
 * @module @deepseek-ai/dsh-experimental-self-update/log
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SelfUpdateJobId, SelfUpdateLogLine } from './types.ts'

/** One job's open log file. */
export interface JobLogFile {
  /** Absolute path of the file this job appends to. */
  readonly path: string
  /**
   * Append one subprocess or system line as `<iso-time> [phase] [stream] text`.
   * @param line - the retained log line.
   */
  line(line: SelfUpdateLogLine): void
  /**
   * Append one job-level note (phase entry, outcome) stamped with the current time.
   * @param text - the note.
   */
  note(text: string): void
}

/**
 * Open (create or append to) the log file for one job. Appends never throw:
 * the first write failure is reported once through `onError` and every later
 * write is skipped, so a lost log cannot fail the update it describes — the
 * owning service already created `logDir` at load, so a failure here is a
 * runtime loss (disk full, directory removed), not a misconfiguration.
 * @param logDir - directory the service created at load.
 * @param id - job identity; its first eight characters name the file.
 * @param startedAt - job start time, stamped into the file name.
 * @param onError - receives the first append failure.
 * @returns the open file.
 */
export function openJobLogFile(
  logDir: string,
  id: SelfUpdateJobId,
  startedAt: number,
  onError: (error: Error) => void,
): JobLogFile {
  const stamp = new Date(startedAt).toISOString().replaceAll(':', '-')
  const path = join(logDir, `${stamp}-${id.slice(0, 8)}.log`)
  let failed = false
  const append = (text: string): void => {
    if (failed) return
    try {
      appendFileSync(path, `${text}\n`, 'utf8')
    } catch (error) {
      failed = true
      // node:fs only ever throws Error instances (with errno codes).
      onError(error as Error)
    }
  }
  return {
    path,
    line(line) {
      append(`${new Date(line.at).toISOString()} [${line.phase}] [${line.stream}] ${line.text}`)
    },
    note(text) {
      append(`${new Date().toISOString()} ${text}`)
    },
  }
}
