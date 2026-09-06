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
  restarting: '正在重启…',
  reconnecting: '正在重新连接…',
  jobAlreadyRunning: '已有更新正在进行',
  lastRunSucceeded: '已从 {from} 更新到 {to}',
  lastRunFailed: '上次更新失败',
  error: '请求失败：{message}',
  'phase.preflight': '前置检查',
  'phase.fetching': '拉取上游',
  'phase.backing-up': '备份会话数据',
  'phase.resetting': '重置到上游',
  'phase.overlaying': '叠加本地插件',
  'phase.installing': '安装依赖',
  'phase.building': '构建',
  'phase.verifying': '验证构建',
  'phase.committing': '提交',
  'phase.restarting': '重启',
  'failure.dirty-working-tree': '工作区存在未提交的更改',
  'failure.job-already-running': '已有更新正在进行',
  'failure.app-exit-unavailable': '当前部署不支持重启',
  'failure.overlay-ref-missing': '找不到插件源分支 {ref}',
  'failure.fetch-failed': '拉取上游失败',
  'failure.backup-failed': '备份会话数据失败',
  'failure.reset-failed': '重置到上游失败',
  'failure.overlay-failed': '叠加本地插件失败',
  'failure.install-failed': '安装依赖失败，已回滚',
  'failure.build-failed': '构建失败，已回滚',
  'failure.verify-failed': '验证构建失败，已回滚',
  'failure.commit-failed': '提交失败，已回滚',
  'failure.rollback-failed': '回滚失败，需要人工处理',
  'failure.unexpected': '发生意外错误',
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
  restarting: 'Restarting…',
  reconnecting: 'Reconnecting…',
  jobAlreadyRunning: 'An update is already in progress',
  lastRunSucceeded: 'Updated {from} → {to}',
  lastRunFailed: 'The last update failed',
  error: 'Request failed: {message}',
  'phase.preflight': 'Checking prerequisites',
  'phase.fetching': 'Fetching upstream',
  'phase.backing-up': 'Backing up Session data',
  'phase.resetting': 'Resetting onto upstream',
  'phase.overlaying': 'Overlaying local plugin',
  'phase.installing': 'Installing dependencies',
  'phase.building': 'Building',
  'phase.verifying': 'Verifying build',
  'phase.committing': 'Committing',
  'phase.restarting': 'Restarting',
  'failure.dirty-working-tree': 'The working tree has uncommitted changes',
  'failure.job-already-running': 'An update is already in progress',
  'failure.app-exit-unavailable': 'This deployment does not support restarting',
  'failure.overlay-ref-missing': 'Plugin source branch {ref} was not found',
  'failure.fetch-failed': 'Fetching upstream failed',
  'failure.backup-failed': 'Backing up Session data failed',
  'failure.reset-failed': 'Resetting onto upstream failed',
  'failure.overlay-failed': 'Overlaying the local plugin failed',
  'failure.install-failed': 'Installing dependencies failed; rolled back',
  'failure.build-failed': 'Building failed; rolled back',
  'failure.verify-failed': 'Verifying the build failed; rolled back',
  'failure.commit-failed': 'Committing failed; rolled back',
  'failure.rollback-failed': 'Rollback failed; manual intervention is needed',
  'failure.unexpected': 'An unexpected error occurred',
} satisfies Record<SelfUpdateKey, string>
