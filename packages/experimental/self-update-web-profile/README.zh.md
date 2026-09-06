---
description: "为源码 checkout 的 Web profile 添加实验性 self-update Update 按钮。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-self-update-web-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-self-update-web-profile` 是 [self-update](../self-update/README.zh.md) 的私有 Web 层：一个侧边栏 Update 按钮，可 fetch、重置到上游、叠加本部署自己的插件树、重建并重启一个源码 checkout 部署。把它放在 `@deepseek-ai/dsh-web-app` 之后即可一步挂载 Host Remote service 与其浏览器控件。正式发布会排除本包，因此只能从源码 checkout 使用，且其配置是部署特定的（针对这台确切机器的 checkout 与 `$DSH_HOME` 的绝对路径）。

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

### 安装到 profile

在本仓库 checkout 中，把 Web 层添加到已初始化的 `web` profile：

```sh
pnpm dsh plugin --profile web add ./packages/experimental/self-update-web-profile
```

这会激活本包声明的 patch，挂载 `self-update` Host 行与 `ui-self-update` Client 行。profile 必须重启（在 pm2 supervise 的部署下执行 `pm2 restart dsh-web`）才能应用新 bundle。执行 `dsh plugin --profile web remove @deepseek-ai/dsh-experimental-self-update-web-profile` 移除本包时，Web 层也会从 profile 的有序 bundle 列表中移除。

### 安装前：为本次部署编辑 `cordis.patch.yml`

`self-update` 行 `config` 下的每个字段都是绝对的、部署特定的值：`repoRoot`（本进程运行所在的 git checkout）、`extraPathDirs`（supervisor 精简 `PATH` 中缺失的目录，最常见的是 `pnpm` 自身所在的位置）、`backupRoot`、`logDir`、`sessionsDir`、`storagesDir` 与 `attachmentsDir`（本部署的 `$DSH_HOME` 子目录）。`overlayRef` 命名持有本部署自己插件树的本地分支（`self-update-plugin`），`overlayPaths` 精确命名该分支拥有的、位于 `repoRoot` 之下的路径——本部署在上游之上添加的每一个路径都必须列在那里，否则一次更新会悄悄地永远不恢复它。`buildArgv` 指向位于叠加内容自身之中的 [`overlay/build.mjs`](overlay/build.mjs)：它会先 `tsc -b` 本包自己的三个 `tsconfig.json`（这些包在上游不知道的根聚合中未做任何注册），然后再运行普通的根级 `pnpm run build`。在不同机器或 checkout 上安装前，把 `cordis.patch.yml` 复制进 profile 级的 `--patch` overlay，或就地编辑它；每个字段的含义见 [`dsh-experimental-self-update` 的配置](../self-update/README.zh.md#configuration)。

### 获得的功能

侧边栏 footer 会获得一个带有落后 commit 数徽标的 Update 按钮。打开它会显示当前 commit、一对 Check/Update 控件、任务运行期间的实时 phase 与日志输出，以及重启完成后的自动重新加载。[`@deepseek-ai/dsh-experimental-client-ui-self-update`](../client-ui-self-update/README.zh.md) 负责这些浏览器交互，并挂载用于访问 Host [`dsh-experimental-self-update`](../self-update/README.zh.md) 服务的生成 Client Remote namespace。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包的运行时内容是 [`cordis.patch.yml`](cordis.patch.yml)。在 `dsh-web-app` 之后应用时，它唯一的 `insert` 条目会添加两行：`self-update`（带有本次部署配置的 Host Remote service）与 `ui-self-update`（挂载生成的 Remote 与侧边栏按钮的 Client plugin）。这个静态 bundle 不持有可变状态，也不安装自己的运行时不变式。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 包含 `self-update` 与 `ui-self-update` 行的有序 Web patch |
| [`overlay/build.mjs`](overlay/build.mjs) | `buildArgv` 入口点：先 `tsc -b` 叠加内容自己的三个包，再运行根级构建 |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 是运行时内容 |
| [`src/invariant.ts`](src/invariant.ts) | 静态 bundle 的空不变式伴生插件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md)——孵化状态与发布排除规则。
- [self-update Host service](../self-update/README.zh.md)——Remote namespace、任务状态机与配置参考。
- [self-update 浏览器 UI](../client-ui-self-update/README.zh.md)——侧边栏按钮、面板与重连重新加载行为。
- [Web bundle](../../bundle/web-app/README.zh.md)——本 patch 扩展的稳定浏览器层。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本 bundle 插入的两行都不注册工具、提示词分区或 Session event。

#### KV Cache 影响

本 Web bundle 不添加任何模型请求内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **部署特定配置**——`cordis.patch.yml` 中的每个绝对路径都命名了这台确切机器的 checkout 与 `$DSH_HOME`；迁移到另一台机器需要编辑它们（见上方「安装前」）。
- **`overlayPaths` 需要手动保持同步**——在叠加分支中添加一个不在 `cordis.patch.yml` 已列出路径中的文件，并不会让一次更新恢复它；这份列表是维护者手动编辑的允许列表，不是从分支自身的树派生出来的。
- **有序组合**——`dsh-base`、`dsh-web-app` 与本包必须保持这个顺序。
- **仅限源码 checkout**——正式 CLI、Web、npm 与 Python 发布产物都不包含这个私有包。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
