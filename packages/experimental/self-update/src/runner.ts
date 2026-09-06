/**
 * One shared streaming-subprocess runner: resolves `argv[0]` in this
 * deployment's PATH, spawns it, and forwards decoded stdout/stderr lines to a
 * caller-supplied sink as they arrive.
 * @module @deepseek-ai/dsh-experimental-self-update/runner
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.subprocess Context merge into this compilation face.
import type {} from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'
import type { SelfUpdateLogLine, SelfUpdatePhase } from './types.ts'

/** Outcome of one streamed subprocess run: never throws for a non-zero exit. */
export interface RunOutcome {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

/** Decode a stream's bytes into complete lines, holding back a trailing partial line. */
class LineDecoder {
  private buffer = ''

  push(chunk: Buffer, onLine: (text: string) => void): void {
    this.buffer += chunk.toString('utf8')
    // String.prototype.split always returns at least one element.
    const lines = this.buffer.split('\n') as [string, ...string[]]
    this.buffer = lines.pop() as string
    for (const line of lines) onLine(line.replace(/\r$/, ''))
  }

  flush(onLine: (text: string) => void): void {
    if (this.buffer.length > 0) onLine(this.buffer.replace(/\r$/, ''))
    this.buffer = ''
  }
}

/**
 * Run one deployment-configured command, streaming decoded lines to `onLine`
 * as `phase`-tagged {@link SelfUpdateLogLine}s. Resolves once the process
 * exits; a resolve/spawn failure (missing executable, cwd, or permission)
 * rejects, distinct from an ordinary non-zero exit.
 * @param ctx - context carrying the subprocess capability.
 * @param config - deployment policy (`repoRoot`, `extraPathDirs`, `graceMs`).
 * @param argv - executable and arguments; `argv[0]` is resolved through PATH.
 * @param phase - phase tag attached to every emitted log line.
 * @param onLine - sink invoked for every decoded line, in arrival order.
 * @param signal - aborts the run, escalating SIGTERM then SIGKILL.
 * @returns exit facts of the finished process.
 */
export async function runStreaming(
  ctx: Context,
  config: Config,
  argv: readonly string[],
  phase: SelfUpdatePhase,
  onLine: (line: SelfUpdateLogLine) => void,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  if (argv.length === 0) throw new Error('self-update: argv must name an executable')
  const env: Record<string, string> = {
    PATH: [...config.extraPathDirs, process.env['PATH'] ?? ''].join(':'),
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
  }
  const executable = await ctx.subprocess.resolveExecutable(argv[0] as string, env, signal)
  const handle = ctx.subprocess.spawn({
    argv: [executable, ...argv.slice(1)],
    cwd: config.repoRoot,
    stdio: {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
    graceMs: config.graceMs,
    signal,
    env,
  })

  let seq = 0
  const emit = (stream: 'stdout' | 'stderr', text: string): void => {
    if (text.length === 0) return
    onLine({ seq: seq++, phase, stream, text, at: Date.now() })
  }

  const stdoutDecoder = new LineDecoder()
  const stderrDecoder = new LineDecoder()
  handle.stdout?.on('data', (chunk: Buffer) => { stdoutDecoder.push(chunk, (text) => { emit('stdout', text) }) })
  handle.stderr?.on('data', (chunk: Buffer) => { stderrDecoder.push(chunk, (text) => { emit('stderr', text) }) })

  try {
    const outcome = await handle.done
    stdoutDecoder.flush((text) => { emit('stdout', text) })
    stderrDecoder.flush((text) => { emit('stderr', text) })
    return outcome
  } finally {
    handle.terminate()
    await handle.waitForExit()
  }
}
