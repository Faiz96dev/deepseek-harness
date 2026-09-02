---
description: "使用并排查实验性 Web 侧边栏 Update 按钮与 self-update 进度面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-self-update

[English](README.md) | 中文

## 概述

本包向 Web 侧边栏 footer 添加一个 Update 入口，让用户无需离开浏览器即可检查并应用上游更新。它挂载生成的 `ctx.remote.selfUpdate` contribution，通过其 `follow` 流跟踪当前任务的实时 phase 与日志，并在重启完成、连接重新建立后重新加载页面。需要实验性源码 checkout Web profile 时选择本包；正式发布会排除它。本包不持有任何权威状态——它展示的每个事实都来自 Host [`dsh-experimental-self-update`](../self-update/README.zh.md) 服务。

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

在稳定 Web bundle 之后，通过 [`@deepseek-ai/dsh-experimental-self-update-web-profile`](../self-update-web-profile/README.zh.md) 安装本包。Web Client loader 挂载 `/client` export；root Host export 不执行行为，本包也没有自己的用户配置字段。

### 检查并应用更新

footer 按钮显示一个状态点：绿色表示已是最新，检查发现落后于上游的 commit 时为琥珀色，任务运行时为蓝色。打开面板会加载 status 与当前任务（如果有）；第一行始终显示已检出的发布版本与 `HEAD` 短 sha。「Check」会 fetch 上游并报告该 checkout 落后多远。「Update」会请求确认后启动一个任务；如果一个或多个 Session 当前处于活动状态，会显示一条警告，说明它们进行中的轮次将被中断（并在下次打开时透明恢复），并要求显式点击「Update anyway」才能继续。

### 观察进度并在重启后恢复

任务运行期间，面板显示其当前 phase 以及底层 git/install/build/verify 输出的滚动日志。任务进入重启阶段后，面板切换为「Restarting…」横幅；此后物理连接重新建立时，页面会自动重新加载，确保每个 client bundle 都是最新的。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 挂载来自 [`@deepseek-ai/dsh-experimental-self-update/remote`](../self-update/README.zh.md) 的生成式 `ctx.remote.selfUpdate` contribution，然后通过 Cordis effect 注册其 locale dictionary 与一个侧边栏 footer slot 条目。`SelfUpdateController`（浏览器本地对象层）持有当前 status、任务与累积的日志；它在整个面板生命周期中只打开一个 `follow` 订阅，并以该流的基线帧为种子，因此迟到的订阅方、第二个标签页，或被 dev-mode HMR 重新挂载的组件，总是从完整的当前状态开始，而不是从局部状态开始。`onReconnect` 把物理 `connection/reset` event 暴露为一个普通的回调注册，因为组件从不直接读取 `ctx`。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 生成式 Remote 挂载、locale 与 slot registration |
| [`src/client/controller.ts`](src/client/controller.ts) | 浏览器本地对象层：status、任务、日志与实时 follow 订阅 |
| [`src/client/SelfUpdateAction.tsx`](src/client/SelfUpdateAction.tsx) | 触发按钮与面板：status、Check/Update 控件、phase 列表、日志 |
| [`src/client/slots.ts`](src/client/slots.ts) | 侧边栏 footer 条目注入的 business face 与完整 props 类型 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文面板文案 |
| [`src/index.ts`](src/index.ts) | 不执行行为的 Host entry |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [self-update Web profile](../self-update-web-profile/README.zh.md)——挂载本 Client plugin 的源码 checkout bundle。
- [self-update service](../self-update/README.zh.md)——权威任务状态机与 Remote 行为。
- [侧边栏 UI](../../client/ui-sidebar/README.zh.md)——本包条目占用的稳定 `sidebar.footer.action` slot。
- [实验性包](../README.zh.md)——孵化状态与发布排除规则。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该浏览器 projection 不注册任何面向模型的输入。

#### KV Cache 影响

无直接影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **重启前的完整页面重新加载不保留进度**——如果任务运行期间标签页重新加载（或被关闭），面板重新打开时只会得到一个全新 `follow` 基线报告的内容；不存在单独的日志历史视图。
- **重连即无条件重新加载**——只要面板认为重启正在进行，任何 `connection/reset` 都会触发 `location.reload()`；否则空闲面板上一次偶发的重连不会触发（该检查以 `restarting` 这个 view flag 为门槛）。
- **`activeSessions` 是一个粗略的代理指标**——它统计当前附着于一个 live fiber 的 Session 数，而不是字面意义上的「一个轮次正在进行」，因此警告可能会出现在一个空闲但已打开的 Session 上。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
