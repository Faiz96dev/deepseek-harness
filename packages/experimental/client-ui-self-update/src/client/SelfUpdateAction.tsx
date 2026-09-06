import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { IconRefreshOutline14, StateDot, useDismissOnOutsidePointer, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SelfUpdateFailure, SelfUpdateJobSnapshot, SelfUpdatePhase, SelfUpdateStatusValue } from '@deepseek-ai/dsh-experimental-self-update/types'
import type { SelfUpdateActionProps } from './slots.ts'
import css from './SelfUpdateAction.module.css'

const PHASES: readonly SelfUpdatePhase[] = [
  'preflight', 'fetching', 'backing-up', 'resetting', 'overlaying', 'installing', 'building', 'verifying', 'committing', 'restarting',
]

function dotState(hasActiveJob: boolean, failed: boolean, behind: number): StateDotState {
  if (failed) return 'error'
  if (hasActiveJob) return 'ongoing'
  return behind > 0 ? 'warning' : 'done'
}

function isFailedOutcome(outcome: SelfUpdateJobSnapshot['outcome']): boolean {
  return outcome !== null && outcome !== 'succeeded' && outcome !== 'up-to-date'
}

/**
 * Sidebar footer entry point for checking and running a self-update. Renders
 * a small badge reflecting repository/job state, and a popover panel with
 * status, Check/Update controls, live progress, and a restart banner. A
 * single "Update" click starts the job immediately — no separate
 * confirmation step — and the panel stays open and un-dismissable by an
 * outside click for as long as a job is running, so its live progress is
 * never lost behind an accidental close; it also opens on its own the
 * moment a job becomes active, even one started from elsewhere.
 * @param props - runtime slot currency (`wide`), the injected business face, and the namespace translator.
 * @returns the trigger button and its popover panel.
 */
export function SelfUpdateAction({ wide, useUpdate, ensure, check, start, onReconnect, t }: SelfUpdateActionProps) {
  const restarting = useUpdate(view => view.restarting)
  const repository = useUpdate(view => view.repository)
  const job = useUpdate(view => view.job)
  const log = useUpdate(view => view.log)
  const error = useUpdate(view => view.error)
  const refusal = useUpdate(view => view.refusal)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const jobActive = job !== null && job.finishedAt === null
  const failed = job !== null && isFailedOutcome(job.outcome)
  const behind = repository?.behind ?? 0
  const badgeState = dotState(jobActive, failed, behind)

  useDismissOnOutsidePointer(rootRef, open && !jobActive, setOpen)

  useEffect(() => {
    if (open) void ensure()
  }, [open, ensure])

  // A job can become active from elsewhere (another tab, a stale click
  // retried by the Host) — the panel opens on its own rather than leaving
  // live progress unseen behind a closed trigger.
  useEffect(() => {
    if (jobActive) setOpen(true)
  }, [jobActive])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log.length])

  useEffect(() => onReconnect(() => {
    if (restarting) window.location.reload()
  }), [onReconnect, restarting])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open || jobActive) return
    event.preventDefault()
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-label={t('trigger')}
        onClick={() => { setOpen(current => !current) }}
      >
        <StateDot state={badgeState} className={css.triggerDot} />
        {wide ? <span className={css.label}>{t('trigger')}</span> : null}
      </button>
      {open
        ? (
          <div className={css.panel} role="dialog" aria-label={t('panelTitle')}>
            <div className={css.panelTitle}>{t('panelTitle')}</div>
            {restarting
              ? <div className={css.restarting}>{t('restarting')}</div>
              : (
                <>
                  <StatusLine repository={repository} t={t} />
                  {jobActive
                    ? <PhaseList phase={job.phase} t={t} />
                    : (
                      <div className={css.actions}>
                        <button type="button" className={css.actionButton} onClick={() => { void check() }}>
                          {t('check')}
                        </button>
                        <button type="button" className={css.actionButtonPrimary} onClick={() => { void start() }}>
                          {t('update')}
                        </button>
                      </div>
                    )}
                  {refusal !== null ? <div className={css.failure}>{t(`failure.${refusal}`)}</div> : null}
                  {error !== null ? <div className={css.failure}>{t('error', { message: error })}</div> : null}
                  {job !== null && job.failure !== null
                    ? <FailureLine failure={job.failure} t={t} />
                    : null}
                  {job !== null
                    ? (
                      <div ref={logRef} className={css.log}>
                        {log.map(line => (
                          <div key={line.seq} className={line.stream === 'stderr' ? css.logLineError : css.logLine}>
                            {line.text}
                          </div>
                        ))}
                      </div>
                    )
                    : null}
                </>
              )}
          </div>
        )
        : null}
    </div>
  )
}

function StatusLine({ repository, t }: { repository: SelfUpdateStatusValue | null; t: SelfUpdateActionProps['t'] }) {
  if (repository === null) return null
  return (
    <>
      <div className={css.status}>{t('version', { version: repository.version, sha: repository.head.sha.slice(0, 7) })}</div>
      <div className={css.status}>{upstreamLine(repository, t)}</div>
    </>
  )
}

function upstreamLine(repository: SelfUpdateStatusValue, t: SelfUpdateActionProps['t']): string {
  if (repository.behind === null) return repository.head.subject
  if (repository.behind === 0) return t('upToDate')
  return t('behind', { count: repository.behind })
}

function PhaseList({ phase, t }: { phase: SelfUpdatePhase; t: SelfUpdateActionProps['t'] }) {
  const currentIndex = PHASES.indexOf(phase)
  return (
    <ul className={css.phases}>
      {PHASES.map((candidate, index) => (
        <li
          key={candidate}
          className={index === currentIndex ? css.phaseCurrent : index < currentIndex ? css.phaseDone : css.phasePending}
        >
          <IconRefreshOutline14 className={index === currentIndex ? css.phaseIconSpin : css.phaseIcon} />
          {t(`phase.${candidate}`)}
        </li>
      ))}
    </ul>
  )
}

function FailureLine({ failure, t }: { failure: SelfUpdateFailure; t: SelfUpdateActionProps['t'] }) {
  if (failure.code === 'overlay-ref-missing') {
    return <div className={css.failure}>{t('failure.overlay-ref-missing', { ref: failure.ref })}</div>
  }
  return <div className={css.failure}>{t(`failure.${failure.code}`)}</div>
}
