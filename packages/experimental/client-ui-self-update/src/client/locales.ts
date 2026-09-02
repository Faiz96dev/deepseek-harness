/** Self-update Web dictionaries. */

/** Locale namespace owned by the self-update Web UI. */
export const NS = 'self-update'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  trigger: '更新',
  panelTitle: '更新 DeepSeek Harness',
  version: '版本 {version}（{sha}）',
  upToDate: '已是最新版本',
  behind: '落后上游 {count} 个提交',
  check: '检查更新',
  update: '更新',
  confirm: '确认更新',
  cancel: '取消',
  restarting: '正在重启…',
  reconnecting: '正在重新连接…',
  activeSessionsWarning: '有 {count} 个会话正在进行，更新将中断其当前回复（下次打开时会自动标记为已中断，不会丢失记录）。',
  updateAnyway: '仍然更新',
  jobAlreadyRunning: '已有更新正在进行',
  lastRunSucceeded: '已从 {from} 更新到 {to}',
  lastRunFailed: '上次更新失败',
  'phase.preflight': '前置检查',
  'phase.fetching': '拉取上游',
  'phase.backing-up': '备份会话数据',
  'phase.merging': '合并',
  'phase.installing': '安装依赖',
  'phase.building': '构建',
  'phase.verifying': '验证构建',
  'phase.restarting': '重启',
  'failure.dirty-working-tree': '工作区存在未提交的更改',
  'failure.job-already-running': '已有更新正在进行',
  'failure.app-exit-unavailable': '当前部署不支持重启',
  'failure.active-sessions-need-acknowledgement': '需要确认正在进行的会话',
  'failure.fetch-failed': '拉取上游失败',
  'failure.backup-failed': '备份会话数据失败',
  'failure.merge-conflict': '合并冲突，已自动放弃合并',
  'failure.merge-failed': '合并未能开始，工作区未受影响，可重试',
  'failure.merge-unrecoverable': '合并失败且无法自动恢复，需要人工处理',
  'failure.install-failed': '安装依赖失败，已回滚',
  'failure.build-failed': '构建失败，已回滚',
  'failure.verify-failed': '验证构建失败，已回滚',
  'failure.rollback-failed': '回滚失败，需要人工处理',
} satisfies Record<string, string>

/** Self-update locale key union. */
export type SelfUpdateKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The sidebar Update button and panel's copy. */
    'self-update': SelfUpdateKey
  }
}

/** English dictionary checked against the Chinese key set. */
export const en = {
  trigger: 'Update',
  panelTitle: 'Update DeepSeek Harness',
  version: 'Version {version} ({sha})',
  upToDate: 'Up to date',
  behind: 'Behind upstream by {count} commit(s)',
  check: 'Check for updates',
  update: 'Update',
  confirm: 'Confirm update',
  cancel: 'Cancel',
  restarting: 'Restarting…',
  reconnecting: 'Reconnecting…',
  activeSessionsWarning: '{count} session(s) are in progress. Updating will interrupt their current reply (it is marked interrupted automatically next time it is opened; no history is lost).',
  updateAnyway: 'Update anyway',
  jobAlreadyRunning: 'An update is already in progress',
  lastRunSucceeded: 'Updated {from} → {to}',
  lastRunFailed: 'The last update failed',
  'phase.preflight': 'Checking prerequisites',
  'phase.fetching': 'Fetching upstream',
  'phase.backing-up': 'Backing up Session data',
  'phase.merging': 'Merging',
  'phase.installing': 'Installing dependencies',
  'phase.building': 'Building',
  'phase.verifying': 'Verifying build',
  'phase.restarting': 'Restarting',
  'failure.dirty-working-tree': 'The working tree has uncommitted changes',
  'failure.job-already-running': 'An update is already in progress',
  'failure.app-exit-unavailable': 'This deployment does not support restarting',
  'failure.active-sessions-need-acknowledgement': 'Active sessions need acknowledgement',
  'failure.fetch-failed': 'Fetching upstream failed',
  'failure.backup-failed': 'Backing up Session data failed',
  'failure.merge-conflict': 'Merge conflicted and was automatically aborted',
  'failure.merge-failed': 'Merge did not start; the working tree is unaffected and this can be retried',
  'failure.merge-unrecoverable': 'Merge failed and could not be automatically recovered; manual intervention is needed',
  'failure.install-failed': 'Installing dependencies failed; rolled back',
  'failure.build-failed': 'Building failed; rolled back',
  'failure.verify-failed': 'Verifying the build failed; rolled back',
  'failure.rollback-failed': 'Rollback failed; manual intervention is needed',
} satisfies Record<SelfUpdateKey, string>
