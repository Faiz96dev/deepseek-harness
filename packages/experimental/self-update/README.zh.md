---
description: "从配置的上游分支拉取、重置到上游、叠加本部署自己的插件树、重建并重启 dsh checkout，供接线或调试 self-update 任务的运维人员使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-self-update

[English](README.md) | 中文

## 概述

`dsh-experimental-self-update` 为一个部署运行它自己的升级流程：从配置的上游 remote 与分支 fetch，将 checkout 硬重置到其已 fetch 的顶端，从一个配置的 git ref 恢复本部署自己的叠加路径（一棵插件树），安装依赖，重建每个产物，校验重建后的树能启动，提交叠加后的树，然后重启进程，让进程 supervisor（pm2、systemd、launchd）切换到新构建。重置到上游而不是合并进上游，意味着一次更新绝不会与自身冲突：上游自身的历史从未被分叉，只是被镜像然后叠加，因此本部署自身历史触及过的任何东西都不可能与一次上游变更相撞。`resetting` 之后的每一步都针对重置并叠加后的工作树运行；install、build、verify 或最终提交期间的失败会触发自动回滚到更新前的 commit，并重建该 commit 自身的产物，因此运行中的（旧）进程绝不会被留在与其自身 git 树不匹配的产物上。持久 Session 数据完全存放在 git checkout 之外（`$DSH_HOME`），因此本包执行的任何操作都不会丢失或损坏对话；即便如此，仍会在更新前尽力写入一份该数据的快照，作为供人类运维人员使用的灾难恢复产物。浏览器控件位于单独的 client 包中；本包是 Host Remote service。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当单一运维人员的源码 checkout 部署应该通过浏览器按钮自我更新、而不是手动执行 `git`/`pnpm` 序列，且它自身的本地附加物（插件、部署胶水代码）完全位于一组可从单个 git ref 恢复的固定路径下时，选择本服务。它假定进程运行在一个会在干净退出后重启的 supervisor 之下（pm2 的 `autorestart`、systemd、launchd）；服务自身从不重新执行或 fork 替代进程——它只调用有界退出请求，并信任 supervisor 会把它重新拉起。

<a id="configuration"></a>
### 配置

| 字段 | 含义 |
|---|---|
| `repoRoot` | 本进程运行所在 git checkout 的绝对路径。 |
| `remoteName` | 持有父仓库的 git remote（fork 的 `upstream`）。 |
| `branch` | `remoteName` 上本 checkout 跟踪的分支。 |
| `overlayRef` | 持有本部署自己叠加路径的 git ref（一个本地分支），每次更新都会从它恢复。 |
| `overlayPaths` | 重置到已 fetch 的上游顶端之后，从 `overlayRef` 恢复的路径（相对 `repoRoot`）。 |
| `installArgv` | 针对重置并叠加后的树安装依赖的 argv。 |
| `buildArgv` | 重建本部署所服务的每个产物的 argv。 |
| `verifyArgv` | 在重启进入新构建的树之前，必须以 exit 0 结束的 argv。 |
| `extraPathDirs` | 在解析并运行上述每个 argv 之前，prepend 到 `PATH` 的目录。 |
| `backupRoot` | 持有每次更新前快照各自一个带时间戳子目录的目录。 |
| `keepBackups` | `backupRoot` 中保留的快照数；成功备份后更早的快照会被清理。 |
| `sessionsDir` | 持久 Session 日志目录（`dsh-session-persistence-jsonl` 的 `root`）。 |
| `storagesDir` | 持久 KV 存储域目录（`dsh-storage-json` 的 `root`）。 |
| `attachmentsDir` | 内容寻址的附件目录。 |
| `graceMs` | 每个 spawn 出的子进程从 SIGTERM 升级到 SIGKILL 的宽限期，单位毫秒。 |
| `maxLogLines` | 每个任务的有界内存日志行数。 |
| `logDir` | 每个任务一个追加写日志文件的目录；在加载时创建，因此无法创建的路径会让插件加载失败。 |

每个字段都是必填的：这些字段没有一个能安全地跨部署给出默认值（维护者可能用 `npm` 而不是 `pnpm`、运行一个命名不同的 remote，或把 `$DSH_HOME` 放在非标准位置），因此 schema 不接受隐式值。已配置好的示例见 [`dsh-experimental-self-update-web-profile`](../self-update-web-profile/README.zh.md)。

### 操作

| 操作 | 请求 | 结果 |
|---|---|---|
| `status` | — | 已检出的 `version`（来自 `<repoRoot>/package.json`）、当前仓库事实、进行中的任务（如果有）与最近一次结束的任务 |
| `check` | — | fetch `remoteName`/`branch`，然后返回 `status` |
| `start` | — | 已启动任务的快照，或一个稳定的业务拒绝 |
| `follow`（流式） | — | 一个把 `status` 与当前任务已保留日志相结合的基线，随后是实时的 phase／log／done 增量 |

`start` 会在以下情况下同步拒绝——不创建任务：已有另一个任务在运行、工作树携带未提交的变更，或本组合中没有可用的有界退出请求。当前附着于一个 live fiber 的任何 Session 都会被 flush 到磁盘，其进行中的轮次会在下次打开时被透明修复——见下方[持久性](#durability)——没有单独的确认步骤：一次 start 绝不会等待、或询问关于活动 Session 的事情。

### 任务阶段

`preflight → fetching → backing-up → resetting → overlaying → installing → building → verifying → committing → restarting`，以四种结果之一结束：`succeeded`（已请求重启）、`up-to-date`（没有需要重置到的 commit；之后什么都没运行）、`failed`（preflight、fetch、backup、reset 或 overlay 失败；该阶段之后什么都没运行），或 `rolled-back`（成功 reset 与 overlay 之后 install、build、verify 或最终提交失败；树已重置到更新前的 commit 并重建）。

<a id="durability"></a>
### 持久性

回滚只会用 `git reset --hard <preUpdateHead>` 恢复 git 树，这正是更新开始前 HEAD 所在的那个 commit——这是一个只有在 preflight 已经要求工作树干净之后才执行的操作，因此它绝不会丢弃本次更新本身未引入的 commit。Session、storage 与 attachment 都存放在 `$DSH_HOME` 下，完全位于 git checkout 之外；本任务的任何阶段都不会以触及它们的方式写入 git 跟踪的树，因此 Session storage 中没有任何东西需要回滚来恢复。因即将到来的进程重启而被中断的活动 Session，会在其下次打开时被 harness 自身的崩溃恢复路径（`interruptedTurnClosers`）透明修复：悬空的轮次会被标记为 `interrupted`，对话从一个有效状态继续，不丢失任何历史。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

一个 `SelfUpdateJob` 实例就是一次尝试的完整生命周期控制器：它持有一个冻结的、替换而非改变的快照、一个有界内存日志，以及一组订阅者队列（`follow` 帧），映照 `dsh-api-workspace-controller` 的 Workspace feed 所使用的可重连安全的基线加增量模式。owning 的 `SelfUpdateService` 同一时刻最多持有一个任务，并在当前任务尚未到达终态时拒绝第二个 `start`。

### 子进程执行

每次 `git`、install、build 与 verify 调用都经过一个建立在 `ctx.subprocess` 之上的共享流式运行器（`src/runner.ts`）：`resolveExecutable` 在由 `config.extraPathDirs` 加环境 PATH 构成的 PATH 中查找 `argv[0]`，然后 `spawn` 以管道 stdio 启动子进程，将输出解码为完整的行并随到达转发到任务日志。`GIT_TERMINAL_PROMPT=0` 防止凭据提示无限期挂起一个任务；`GIT_PAGER=cat`/`NO_COLOR=1` 让 git 的输出保持纯文本。每次运行都会在返回前等待进程树退出（或终止），因此失败或中止的阶段绝不会泄漏正在运行的子进程。

### 持久日志

有界的内存任务日志是为浏览器而存在的；而一次更新做了什么的记录，必须活过结束一次成功更新的那个进程重启。因此每个任务都同步追加写入自己的文件 `<logDir>/<start-time>-<job-id-prefix>.log`：一条开始记录、每次进入阶段、每一行子进程与 system 输出（格式为 `<iso-time> [phase] [stream] text`），以及带失败对象的最终结果。进入阶段、结果以及每一次被拒绝的 `start`（附带原因）也会写入 Host logger，因此进程 supervisor 的日志能说明为什么一次点击看起来什么都没做。加载之后的日志文件写入失败只通过 Host logger 报告一次，绝不会让它所描述的更新失败。

### Preflight、重置与叠加

`preflight` 要求在任何操作之前工作树干净、`overlayRef` 可解析（`git rev-parse -q --verify <ref>^{commit}`），且有可解析的有界退出请求。`resetting` 运行 `git reset --hard <已 fetch 的上游顶端>`——从不是一次 merge，因此上游自身的历史从未被分叉进去，也就没有冲突需要解决。`overlaying` 随后运行 `git checkout <overlayRef> -- <overlayPaths...>`，把恰好本部署自己的路径恢复到刚重置好的树上；一个在 `overlayRef` 的树中缺失的路径会让这一步失败（`overlay-failed`），而不是悄悄略过。`revCounts` 针对上次 fetch 的 remote ref 读取 `git rev-list --left-right --count HEAD...<remote>/<branch>`。

### 提交

一旦 install、build 与 verify 都针对重置并叠加后的树成功，`committing` 会运行 `git add -A`，接着运行 `git commit --no-verify -m 'self-update: overlay <overlayRef> onto <sha>'`：叠加的这些路径本身就是从 `overlayRef` 原样恢复的、已经过审查的源码，不是需要 commit hook 把关的新工作，因此绕过 hook。这是本包唯一会创建的 commit，也正是下一次更新的 `resetHard` 会丢弃、并再次从 `overlayRef` 重建的那个 commit——checkout 的历史保持为一条直线：每个上游 commit 之后紧跟至多一个叠加 commit。

### 回滚

成功 reset 与 overlay 之后，install、build、verify 或最终提交失败会触发 `git reset --hard <preUpdateHead>`，随后针对该恢复的 commit 重新 install 与 build，因此当前正在运行的（旧）进程磁盘上的产物始终与其自身的 git 树匹配——即使在失败过程中，磁盘上的 `apps/cli/lib/bin.js` 也绝不会偏离 `HEAD`。如果回滚自身的 install 或 build 也失败，任务会报告 `rollback-failed`，与普通的 `install-failed`/`build-failed`/`commit-failed` 区分开，因为这种状态需要人工运维人员恢复。

### 重启

一次成功的 `verifying` 与 `committing` 阶段进入 `restarting`，向每个打开的 `follow` 流发布最终的 `done` 帧，然后在下一个微任务中调用有界退出请求（`ctx.get('appExit')`)——让流有机会在进程退出前完成 flush。服务从不自行重启进程；它依赖外部 supervisor 的干净退出后重启策略。

### 备份

`src/backup.ts` 在重置开始前，把 `sessionsDir`、`storagesDir` 与 `attachmentsDir` 复制到 `backupRoot` 下一个新的带时间戳子目录，写入一份命名了更新前 commit 的 manifest，然后清理超过 `keepBackups` 的快照。这是供人类使用的灾难恢复产物，不是自动回滚的一部分：本任务的任何阶段（`resetting`、`overlaying`、install、build、verify、`committing`）都不能触及这些目录，因为它们完全位于 git checkout 之外。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Service 类：`@Remote` 方法、单任务归属、status 组合 |
| [`src/job.ts`](src/job.ts) | 更新任务状态机：阶段、转换、回滚、重启 |
| [`src/git.ts`](src/git.ts) | 针对 `config.repoRoot` 的 git 操作 |
| [`src/runner.ts`](src/runner.ts) | 建立在 `ctx.subprocess` 之上的共享流式子进程运行器 |
| [`src/backup.ts`](src/backup.ts) | 更新前 Session 相邻目录快照与保留策略 |
| [`src/log.ts`](src/log.ts) | 持久的单任务追加写日志文件 |
| [`src/config.ts`](src/config.ts) | 经过校验的部署 `Config` |
| [`src/types.ts`](src/types.ts) | 公共请求、值与失败词汇（仅类型） |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；任务状态是进程本地的） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-experimental-client-ui-self-update](../client-ui-self-update/README.zh.md)——驱动本 Remote 约定的浏览器消费方。
- [dsh-experimental-self-update-web-profile](../self-update-web-profile/README.zh.md)——把两半都挂载进 `web` profile 的 Web bundle 层。
- [Subprocess 能力](../../subprocess/subprocess/README.zh.md)——本包运行每个子进程所经由的 Service Definition。
- [Session 持久化子系统](../../../docs/subsystems/persistence.zh.md)——本包依赖而非重新实现的持久性与修复约定。

-----

<a id="model-experience"></a>
## 模型体验

### 本地 self-update 状态

#### 模型看到什么

什么都没有。`ctx.selfUpdate` 不注册任何工具、提示词分区或面向模型的上下文，也不产生 Session event；更新部署是一项运维操作，绝非模型发起的操作。

#### Token 影响

零。本包的任何请求、status、日志行或失败都不会进入模型请求。

#### KV Cache 影响

独立。检查或启动一次更新不会触及模型请求前缀，也不会使原本可复用的 provider 缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了本服务何时不适用，或何时需要特别的运维照料。它们是当前包约束，不是任务待办列表。

- **没有跨进程任务锁**——如果开发者在任务进行期间于终端中手动运行 `pnpm install`/`pnpm run build`，可能会破坏 `node_modules` 或与 lockfile 产生竞争；本包只防止本进程内的第二个任务。
- **构建崩溃的回滚需要人工恢复**——如果回滚自身的 install 或 build 也失败（`rollback-failed`），仓库可能已被恢复，却没有匹配的重建产物树；恢复需要运维人员手动运行 `git status`/`pnpm install`/`pnpm run build`。
- **`verifyArgv` 无法完全证明下一次启动会成功**——它针对刚构建好的树在重启之前运行，但只有在进程 supervisor 实际重启之后才会显现的部署特定运行时失败（端口冲突、缺失的运行时密钥）不会在此被捕获；supervisor 自身的重启循环策略是最后一道防线。
- **没有可移植的默认值**——`repoRoot`、`extraPathDirs`、`backupRoot`、`sessionsDir`、`storagesDir` 与 `attachmentsDir` 都是绝对的、部署特定的路径；把这份配置迁移到另一台机器或 checkout 需要逐一编辑它们。
- **`overlayPaths` 是一份扁平的允许列表，不是清单**——如果本部署自身的树需要某个路径，而它缺失于 `overlayPaths`，该路径就会被悄悄地永远不被恢复（而不是报出配置错误），因为除了配置的列表之外，本包没有独立的真相来源来判断叠加内容应该包含什么。
- **单任务历史**——内存中只保留最近一次结束的任务（`lastRun`）；更早的尝试在更新的任务开始后就不可查询。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文；它明确不具权威性。已发布行为、限制与理由在上面各节、包代码与链接的 Agent Note 中。

- 曾考虑过一个专门的 `SESSION_FORMAT_VERSION` preflight diff（在重置之前，比较上游分支的 session-format 常量与运行中的常量），但被否决：harness 自身的 session-persistence coordinator 已经在读取时拒绝不兼容的格式，fail-closed，不存在悄悄误读的情况——第二个 preflight 检查只会针对一次脆弱的源文本解析重复一个已经安全的机制。
- 早期设计把上游合并进 checkout 自己的分支，该分支与 fork 的其他本地历史一起携带着本包自己的 commit。每一次上游发布只要触及了本部署自己的 commit 也触及过的文件（`knip.json`、生成的 README、`pnpm-lock.yaml`），就会产生一次真实的、可重复的合并冲突——这是在实践中被证实的，不只是理论上的担忧。重置到上游、并从一个独立的 ref 恢复 `overlayPaths`，彻底消除了这个冲突：上游自身的历史从未被分叉过，因此未来的上游 commit 也就没有什么可以与之冲突。

</details>
