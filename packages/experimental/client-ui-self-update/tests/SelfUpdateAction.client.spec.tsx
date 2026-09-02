// @vitest-environment jsdom
/**
 * SelfUpdateAction rendering and gestures: the badge reflects repository/job
 * state, the panel shows status/Check/Update controls, confirmation and the
 * active-Sessions warning gate a start, phase/log progress render while a job
 * runs, and a restart banner appears once the job reaches its restart phase.
 */
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  SelfUpdateJobSnapshot, SelfUpdateLogLine, SelfUpdateStatusValue,
} from '@deepseek-ai/dsh-experimental-self-update/types'
import { SelfUpdateAction } from '../src/client/SelfUpdateAction.tsx'
import type { SelfUpdateActionResult, SelfUpdateView } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

const REPO: SelfUpdateStatusValue = {
  version: '1.2.3',
  head: { sha: 'a'.repeat(40), subject: 'initial' },
  remoteHead: null,
  behind: null,
  ahead: 0,
  dirty: false,
  activeSessions: 0,
  job: null,
  lastRun: null,
}

const JOB: SelfUpdateJobSnapshot = {
  id: 'job-1' as SelfUpdateJobSnapshot['id'],
  phase: 'fetching',
  startedAt: 0,
  finishedAt: null,
  outcome: null,
  failure: null,
  fromCommit: null,
  toCommit: null,
  backupPath: null,
}

/** Render the panel over a fixed view and recording verbs. */
function mount(options: {
  view?: Partial<SelfUpdateView>
  ensureResult?: SelfUpdateActionResult
  checkResult?: SelfUpdateActionResult
  startResult?: SelfUpdateActionResult
  wide?: boolean
} = {}) {
  const view: SelfUpdateView = {
    status: 'ready',
    repository: REPO,
    job: null,
    log: [],
    restarting: false,
    error: null,
    ...options.view,
  }
  const ensure = vi.fn(() => Promise.resolve<SelfUpdateActionResult>(options.ensureResult ?? { ok: true }))
  const check = vi.fn(() => Promise.resolve<SelfUpdateActionResult>(options.checkResult ?? { ok: true }))
  const start = vi.fn(() => Promise.resolve<SelfUpdateActionResult>(options.startResult ?? { ok: true }))
  const reconnectListeners = new Set<() => void>()
  const onReconnect = vi.fn((listener: () => void) => {
    reconnectListeners.add(listener)
    return () => { reconnectListeners.delete(listener) }
  })
  const useUpdate = (<T,>(select: (v: SelfUpdateView) => T): T =>
    useSyncExternalStore(() => () => {}, () => select(view))) as never
  const props = {
    wide: options.wide ?? true, useUpdate, ensure, check, start, onReconnect, t,
  } as unknown as Parameters<typeof SelfUpdateAction>[0]
  const rendered = render(<SelfUpdateAction {...props} />)
  return {
    ...rendered,
    ensure,
    check,
    start,
    fireReconnect: () => { for (const listener of reconnectListeners) listener() },
    // The trigger button's own accessible name duplicates panel copy (both
    // read "更新"), so panel-scoped controls must be queried within the
    // dialog rather than against the whole document.
    panel: () => within(rendered.getByRole('dialog')),
  }
}

describe('SelfUpdateAction', () => {
  it('shows the label when wide and omits it when collapsed', () => {
    const wide = mount({ wide: true })
    expect(wide.getByText(zh.trigger)).toBeTruthy()
    wide.unmount()

    const collapsed = mount({ wide: false })
    expect(collapsed.queryByText(zh.trigger)).toBeNull()
    expect(collapsed.getByLabelText(zh.trigger)).toBeTruthy()
  })

  it('reads status once on open, via ensure', () => {
    const ui = mount()
    expect(ui.ensure).not.toHaveBeenCalled()
    fireEvent.click(ui.getByLabelText(zh.trigger))
    expect(ui.ensure).toHaveBeenCalledOnce()
  })

  it('shows no status line before repository status has ever loaded', () => {
    const ui = mount({ view: { repository: null } })
    fireEvent.click(ui.getByLabelText(zh.trigger))
    expect(ui.queryByText(zh.upToDate)).toBeNull()
    expect(ui.getByText(zh.panelTitle)).toBeTruthy()
  })

  it('shows up to date when behind is zero', () => {
    const ui = mount({ view: { repository: { ...REPO, behind: 0 } } })
    fireEvent.click(ui.getByLabelText(zh.trigger))
    expect(ui.getByText(zh.upToDate)).toBeTruthy()
  })

  it('shows the commits-behind count when behind is positive', () => {
    const ui = mount({ view: { repository: { ...REPO, behind: 3 } } })
    fireEvent.click(ui.getByLabelText(zh.trigger))
    expect(ui.getByText('落后上游 3 个提交')).toBeTruthy()
  })

  it('shows the current commit subject before any check has run', () => {
    const ui = mount()
    fireEvent.click(ui.getByLabelText(zh.trigger))
    expect(ui.getByText('initial')).toBeTruthy()
  })

  it('always shows the checked-out version with the short HEAD sha once status has loaded', () => {
    const ui = mount({ view: { repository: { ...REPO, behind: 0 } } })
    fireEvent.click(ui.getByLabelText(zh.trigger))
    expect(ui.getByText('版本 1.2.3（aaaaaaa）')).toBeTruthy()
    expect(ui.getByText(zh.upToDate)).toBeTruthy()
  })

  it('calls check when the Check button is clicked', () => {
    const ui = mount()
    fireEvent.click(ui.getByLabelText(zh.trigger))
    fireEvent.click(ui.getByText(zh.check))
    expect(ui.check).toHaveBeenCalledOnce()
  })

  it('requires confirmation before starting, then starts with no acknowledgement when no Sessions are active', () => {
    const ui = mount()
    fireEvent.click(ui.getByLabelText(zh.trigger))
    fireEvent.click(ui.panel().getByRole('button', { name: zh.update }))
    expect(ui.start).not.toHaveBeenCalled()
    fireEvent.click(ui.panel().getByRole('button', { name: zh.confirm }))
    expect(ui.start).toHaveBeenCalledWith({})
  })

  it('cancels the confirmation step without starting', () => {
    const ui = mount()
    fireEvent.click(ui.getByLabelText(zh.trigger))
    fireEvent.click(ui.panel().getByRole('button', { name: zh.update }))
    fireEvent.click(ui.panel().getByRole('button', { name: zh.cancel }))
    expect(ui.panel().queryByRole('button', { name: zh.confirm })).toBeNull()
    expect(ui.panel().getByRole('button', { name: zh.update })).toBeTruthy()
    expect(ui.start).not.toHaveBeenCalled()
  })

  it('warns about active Sessions while confirming, and starts with acknowledgement', () => {
    const ui = mount({ view: { repository: { ...REPO, activeSessions: 2 } } })
    fireEvent.click(ui.getByLabelText(zh.trigger))
    fireEvent.click(ui.panel().getByRole('button', { name: zh.update }))
    expect(ui.getByText('有 2 个会话正在进行，更新将中断其当前回复（下次打开时会自动标记为已中断，不会丢失记录）。')).toBeTruthy()
    fireEvent.click(ui.panel().getByRole('button', { name: zh.updateAnyway }))
    expect(ui.start).toHaveBeenCalledWith({ acknowledgeActiveSessions: true })
  })

  it('renders the phase list while a job is active, in place of the Check/Update controls', () => {
    const ui = mount({ view: { job: { ...JOB, phase: 'building' } } })
    fireEvent.click(ui.getByLabelText(zh.trigger))
    expect(ui.panel().queryByRole('button', { name: zh.check })).toBeNull()
    expect(ui.panel().queryByRole('button', { name: zh.update })).toBeNull()
    expect(ui.getByText(zh['phase.building'])).toBeTruthy()
    expect(ui.getByText(zh['phase.fetching'])).toBeTruthy()
  })

  it('renders the accumulated log for an active job', () => {
    const log: SelfUpdateLogLine[] = [
      { seq: 0, phase: 'fetching', stream: 'stdout', text: 'fetching upstream', at: 0 },
      { seq: 1, phase: 'fetching', stream: 'stderr', text: 'a warning', at: 1 },
    ]
    const ui = mount({ view: { job: JOB, log } })
    fireEvent.click(ui.getByLabelText(zh.trigger))
    expect(ui.getByText('fetching upstream')).toBeTruthy()
    expect(ui.getByText('a warning')).toBeTruthy()
  })

  it('shows the failure line once a job settles with a failure', () => {
    const failedJob: SelfUpdateJobSnapshot = {
      ...JOB, finishedAt: 1, outcome: 'failed', failure: { code: 'merge-conflict', message: 'conflict' },
    }
    const ui = mount({ view: { job: failedJob } })
    fireEvent.click(ui.getByLabelText(zh.trigger))
    expect(ui.getByText(zh['failure.merge-conflict'])).toBeTruthy()
  })

  it('shows the restarting banner instead of ordinary content once restarting', () => {
    const ui = mount({ view: { restarting: true } })
    fireEvent.click(ui.getByLabelText(zh.trigger))
    expect(ui.getByText(zh.restarting)).toBeTruthy()
    expect(ui.queryByText(zh.check)).toBeNull()
  })

  it('reloads the page on reconnect while restarting, but not otherwise', () => {
    // jsdom's Location.prototype.reload is not configurable, so the whole
    // `window.location` binding is replaced instead of patching one method;
    // a plain stand-in (not a spread Location instance) avoids losing its
    // prototype in a way that would be meaningless here regardless.
    const originalLocation = window.location
    const reload = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } })
    try {
      const idle = mount({ view: { restarting: false } })
      act(() => { idle.fireReconnect() })
      expect(reload).not.toHaveBeenCalled()
      idle.unmount()

      const restarting = mount({ view: { restarting: true } })
      act(() => { restarting.fireReconnect() })
      expect(reload).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
    }
  })

  it('closes the panel on Escape', () => {
    const ui = mount()
    fireEvent.click(ui.getByLabelText(zh.trigger))
    expect(ui.getByText(zh.panelTitle)).toBeTruthy()
    fireEvent.keyDown(ui.getByText(zh.panelTitle), { key: 'Escape' })
    expect(ui.queryByText(zh.panelTitle)).toBeNull()
  })

  it('ignores a non-Escape key while open', () => {
    const ui = mount()
    fireEvent.click(ui.getByLabelText(zh.trigger))
    fireEvent.keyDown(ui.getByText(zh.panelTitle), { key: 'Enter' })
    expect(ui.getByText(zh.panelTitle)).toBeTruthy()
  })

  it('toggles the panel closed on a second trigger click', () => {
    const ui = mount()
    const trigger = ui.getByLabelText(zh.trigger)
    fireEvent.click(trigger)
    expect(ui.getByText(zh.panelTitle)).toBeTruthy()
    fireEvent.click(trigger)
    expect(ui.queryByText(zh.panelTitle)).toBeNull()
  })
})
