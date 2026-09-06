import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { IconRefreshOutline14, StateDot, useDismissOnOutsidePointer, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SelfUpdateFailure, SelfUpdateJobSnapshot, SelfUpdatePhase, SelfUpdateStatusValue } from '@deepseek-ai/dsh-experimental-self-update/types'
import type { SelfUpdateActionProps } from './slots.ts'
import css from './SelfUpdateAction.module.css'

const PHASES: readonly SelfUpdatePhase[] = [
  'preflight', 'fetching', 'backing-up', 'merging', 'installing', 'building', 'verifying', 'restarting',
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
 * status, Check/Update controls, live progress, and a restart banner.
 * @param props - runtime slot currency (`wide`), the injected business face, and the namespace translator.
 * @returns the trigger button and its popover panel.
 */
export function SelfUpdateAction({ wide, useUpdate, ensure, refresh, check, start, onReconnect, t }: SelfUpdateActionProps) {
  const restarting = useUpdate(view => view.restarting)
  const repository = useUpdate(view => view.repository)
  const job = useUpdate(view => view.job)
  const log = useUpdate(view => view.log)
  const error = useUpdate(view => view.error)
  const refusal = useUpdate(view => view.refusal)

  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useDismissOnOutsidePointer(rootRef, open, setOpen)

  useEffect(() => {
    if (open) void ensure()
  }, [open, ensure])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log.length])

  useEffect(() => onReconnect(() => {
    if (restarting) window.location.reload()
  }), [onReconnect, restarting])

  const jobActive = job !== null && job.finishedAt === null
  const failed = job !== null && isFailedOutcome(job.outcome)
  const behind = repository?.behind ?? 0
  const badgeState = dotState(jobActive, failed, behind)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
  }

  const runStart = (acknowledgeActiveSessions?: boolean): void => {
    setConfirming(false)
    void start(acknowledgeActiveSessions === undefined ? {} : { acknowledgeActiveSessions })
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
                        {confirming
                          ? (
                            <>
                              <button type="button" className={css.actionButtonPrimary} onClick={() => { runStart() }}>
                                {t('confirm')}
                              </button>
                              <button type="button" className={css.actionButton} onClick={() => { setConfirming(false) }}>
                                {t('cancel')}
                              </button>
                            </>
                          )
                          : (
                            <button
                              type="button"
                              className={css.actionButtonPrimary}
                              onClick={() => {
                                // The active-Session warning below must reflect now, not panel-open time.
                                void refresh()
                                setConfirming(true)
                              }}
                            >
                              {t('update')}
                            </button>
                          )}
                      </div>
                    )}
                  {refusal !== null ? <div className={css.failure}>{t(`failure.${refusal}`)}</div> : null}
                  {error !== null ? <div className={css.failure}>{t('error', { message: error })}</div> : null}
                  {confirming && repository !== null && repository.activeSessions > 0
                    ? (
                      <div className={css.warning}>
                        {t('activeSessionsWarning', { count: repository.activeSessions })}
                        <button type="button" className={css.actionButton} onClick={() => { runStart(true) }}>
                          {t('updateAnyway')}
                        </button>
                      </div>
                    )
                    : null}
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
  return <div className={css.failure}>{t(`failure.${failure.code}`)}</div>
}
