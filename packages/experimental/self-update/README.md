---
description: "Fetch, merge, rebuild, and restart a dsh checkout from its configured upstream branch, for operators wiring or debugging the self-update job."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-self-update

English | [中文](README.zh.md)

## Summary

`dsh-experimental-self-update` runs one deployment's own upgrade: fetch a configured upstream remote and branch, merge it into the current branch, install dependencies, rebuild every artifact, verify the rebuilt tree boots, and restart the process so a process supervisor (pm2, systemd, launchd) cycles into the new build. Every step after `merge` runs against the merged working tree; a failure during install, build, or verify triggers an automated rollback to the pre-merge commit and a rebuild of that commit's own artifacts, so the running (old) process is never left serving artifacts that do not match its own git tree. Durable Session data lives entirely outside the git checkout (`$DSH_HOME`), so no operation this package performs can lose or corrupt a conversation; a best-effort pre-update snapshot of that data is still written as a disaster-recovery artifact for a human operator. The browser controls live in a separate client package; this package is the Host Remote service.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Choose this service for a single-operator source-checkout deployment that should update itself from a browser button rather than a manual `git`/`pnpm` sequence. It assumes the process runs under a supervisor that restarts on a clean exit (pm2's `autorestart`, systemd, launchd); the service itself never re-execs or forks a replacement process — it only calls the bounded exit request and trusts the supervisor to cycle it back up.

### Configuration

| Field | Meaning |
|---|---|
| `repoRoot` | Absolute path to the git checkout this process runs from. |
| `remoteName` | Git remote holding the parent repository (a fork's `upstream`). |
| `branch` | Branch on `remoteName` this checkout tracks. |
| `installArgv` | Argv that installs dependencies against the merged tree. |
| `buildArgv` | Argv that rebuilds every artifact this deployment serves. |
| `verifyArgv` | Argv that must exit 0 against the freshly built tree before restarting into it. |
| `extraPathDirs` | Directories prepended to `PATH` before resolving and running every argv above. |
| `backupRoot` | Directory holding one timestamped subdirectory per pre-update snapshot. |
| `keepBackups` | Snapshots retained in `backupRoot`; older ones are pruned after a successful backup. |
| `sessionsDir` | Durable Session log directory (`dsh-session-persistence-jsonl`'s `root`). |
| `storagesDir` | Durable KV storage-domain directory (`dsh-storage-json`'s `root`). |
| `attachmentsDir` | Content-addressed attachment directory. |
| `graceMs` | SIGTERM-to-SIGKILL escalation grace, in milliseconds, for every spawned child. |
| `maxLogLines` | Bounded per-job in-memory log line count. |
| `logDir` | Directory receiving one append-only log file per job; created at load, so an uncreatable path fails the plugin. |

Every field is required: none of these are safe to default across deployments (a maintainer may use `npm` instead of `pnpm`, run a differently named remote, or place `$DSH_HOME` somewhere non-standard), so the schema accepts no implicit value. See [`dsh-experimental-self-update-web-profile`](../self-update-web-profile/README.md) for a worked configuration.

### Operations

| Operation | Request | Result |
|---|---|---|
| `status` | — | the checked-out `version` (from `<repoRoot>/package.json`), current repository facts, active Session count, the in-progress job (if any), and the most recently finished job |
| `check` | — | fetches `remoteName`/`branch`, then returns `status` |
| `start` | optional acknowledgement of active Sessions | the started job's snapshot, or a stable business refusal |
| `follow` (stream) | — | a baseline combining `status` with the current job's retained log, then live phase/log/done increments |

`start` refuses synchronously — without creating a job — when: another job is already running, the working tree carries uncommitted changes, no bounded exit request is available in this composition, or one or more Sessions are currently live and the caller has not set `acknowledgeActiveSessions: true`. A live Session's in-flight turn is not lost when acknowledged and interrupted by the eventual restart — see [Durability](#durability) below — but the caller must opt in rather than have it happen silently.

### Job phases

`preflight → fetching → backing-up → merging → installing → building → verifying → restarting`, ending in one of four outcomes: `succeeded` (restart requested), `up-to-date` (no commits to merge; nothing else ran), `failed` (preflight, fetch, backup, or merge failed; nothing after that phase ran), or `rolled-back` (install, build, or verify failed after a successful merge; the tree was reset to the pre-update commit and rebuilt).

### Durability

Rollback only ever reverts the git tree with `git reset --hard <preUpdateHead>`, which is exactly the commit HEAD was at before the merge began — an operation this package performs only after preflight already required a clean working tree, so it can never discard a commit the merge itself did not introduce. Sessions, storage, and attachments live under `$DSH_HOME`, entirely outside the git checkout; no phase of this job writes to the git-tracked tree in a way that touches them, so there is nothing in Session storage for rollback to restore. A live Session interrupted by the eventual process restart is repaired transparently on its next open by the harness's own crash-recovery path (`interruptedTurnClosers`): the dangling turn is marked `interrupted`, and the conversation continues from a valid state with no lost history.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One `SelfUpdateJob` instance is the whole lifecycle controller for one attempt: it owns a frozen, replaced-not-mutated snapshot, a bounded in-memory log, and a set of subscriber queues (`follow` frames), mirroring the reconnect-safe baseline-then-increments pattern used by `dsh-api-workspace-controller`'s Workspace feed. The owning `SelfUpdateService` holds at most one job at a time and refuses a second `start` while the current one has not reached a terminal outcome.

### Subprocess execution

Every `git`, install, build, and verify invocation goes through one shared streaming runner (`src/runner.ts`) built on `ctx.subprocess`: `resolveExecutable` looks up `argv[0]` in a PATH built from `config.extraPathDirs` plus the ambient PATH, then `spawn` starts the child with piped stdio, decoded into complete lines and forwarded to the job's log as they arrive. `GIT_TERMINAL_PROMPT=0` prevents a credential prompt from hanging a job indefinitely; `GIT_PAGER=cat`/`NO_COLOR=1` keep git's output plain-text. Every run awaits the process tree's exit (or termination) before returning, so a failed or aborted phase never leaks a running child.

### Durable log

The in-memory, bounded job log exists for the browser; the record of what an update did must outlive the process restart that ends a successful one. Every job therefore appends synchronously to its own file, `<logDir>/<start-time>-<job-id-prefix>.log`: a start note, every phase entry, every subprocess and system line as `<iso-time> [phase] [stream] text`, and the settled outcome with its failure object. Phase entries, outcomes, and every refused `start` (with its reason) are also written to the Host logger, so a process supervisor's log names why a click appeared to do nothing. A log-file write failure after load is reported once through the Host logger and never fails the update it describes.

### Preflight and merge safety

`preflight` requires a clean working tree and a resolvable bounded exit request before anything else runs. On a non-zero `git merge --no-edit` exit, `merge` checks whether `MERGE_HEAD` exists before deciding how to report it: a fast-forward-eligible merge never writes `MERGE_HEAD`, so a transient failure there (no conflict, working tree unchanged) reports `merge-failed` without ever invoking `--abort`; only a real conflicted merge (`MERGE_HEAD` present) is aborted and reported as `merge-conflict`. Either way the repository is never left in a conflicted state — the next `start` attempt's preflight is never blocked by a prior failed merge. `revCounts` reads `git rev-list --left-right --count HEAD...<remote>/<branch>` against the last fetched remote ref.

### Rollback

Install, build, or verify failing after a successful merge triggers `git reset --hard <preUpdateHead>` followed by a fresh install and build against that reverted commit, so the currently running (old) process's artifacts on disk always match its own git tree — even mid-failure, `apps/cli/lib/bin.js` on disk never drifts from `HEAD`. If the rollback's own install or build also fails, the job reports `rollback-failed` distinctly from an ordinary `install-failed`/`build-failed`, since that state needs manual operator recovery.

### Restart

A successful `verifying` phase enters `restarting`, publishes the final `done` frame to every open `follow` stream, then calls the bounded exit request (`ctx.get('appExit')`) on the next microtask — giving the stream a chance to flush before the process exits. The service never restarts the process itself; it relies on the external supervisor's restart-on-clean-exit policy.

### Backup

`src/backup.ts` copies `sessionsDir`, `storagesDir`, and `attachmentsDir` into a fresh timestamped subdirectory of `backupRoot` before the merge begins, writes a manifest naming the pre-update commit, then prunes snapshots beyond `keepBackups`. This is a disaster-recovery artifact for a human, not part of the automated rollback: no phase of this job (`merge`, install, build, verify) can touch these directories, since they live outside the git checkout entirely.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service class: `@Remote` methods, single-job ownership, status composition |
| [`src/job.ts`](src/job.ts) | The update job state machine: phases, transitions, rollback, restart |
| [`src/git.ts`](src/git.ts) | Git operations against `config.repoRoot` |
| [`src/runner.ts`](src/runner.ts) | Shared streaming-subprocess runner built on `ctx.subprocess` |
| [`src/backup.ts`](src/backup.ts) | Pre-update Session-adjacent directory snapshot and retention |
| [`src/config.ts`](src/config.ts) | Validated deployment `Config` |
| [`src/types.ts`](src/types.ts) | Public request, value, and failure vocabulary (types only) |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; job state is process-local) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-experimental-client-ui-self-update](../client-ui-self-update/README.md) — the browser consumer that drives this Remote contract.
- [dsh-experimental-self-update-web-profile](../self-update-web-profile/README.md) — the Web bundle layer that mounts both halves into a `web` profile.
- [Subprocess capability](../../subprocess/subprocess/README.md) — the Service Definition this package runs every child process through.
- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — the durability and repair contract this package relies on instead of reimplementing.

-----

<a id="model-experience"></a>
## Model Experience

### Local self-update state

#### What the model sees

Nothing. `ctx.selfUpdate` registers no tool, prompt section, model-facing context, or Session event; updating the deployment is an operator action, never a model-initiated one.

#### Token effect

Zero. No request, status, log line, or failure from this package enters a model request.

#### KV Cache effect

Independent. Checking or starting an update does not touch a model request prefix and cannot invalidate an otherwise reusable provider cache entry.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the service is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **No cross-process job lock** — a developer running `pnpm install`/`pnpm run build` manually in a terminal while a job is in progress can corrupt `node_modules` or race the lockfile; this package only prevents a second job within its own process.
- **A build-crashing rollback needs manual recovery** — if the rollback's own install or build also fails (`rollback-failed`), the repository may be reverted without a matching rebuilt artifact tree; recovery requires an operator to run `git status`/`pnpm install`/`pnpm run build` by hand.
- **`verifyArgv` cannot fully prove the next boot succeeds** — it runs against the freshly built tree before the restart, but a deployment-specific runtime failure that only manifests after the process supervisor's actual restart (a port conflict, a missing runtime secret) is not caught here; the supervisor's own restart-loop policy is the last line of defense.
- **No portable defaults** — `repoRoot`, `extraPathDirs`, `backupRoot`, `sessionsDir`, `storagesDir`, and `attachmentsDir` are absolute, deployment-specific paths; moving this configuration to another machine or checkout requires editing every one of them.
- **Single job history** — only the most recently finished job is retained in memory (`lastRun`); earlier attempts are not queryable after a newer one starts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Shipped behavior, limits, and rationale live in the sections above, the package code, and the linked Agent Note.

- A dedicated `SESSION_FORMAT_VERSION` preflight diff (comparing the upstream branch's session-format constant against the running one before merging) was considered and rejected: the harness's own session-persistence coordinator already refuses an incompatible format on read, fail-closed, with no silent misread — a second preflight check would only duplicate an already-safe mechanism against a brittle source-text parse.
- `activeSessions` is `ctx.sessions.list().length` — the count of Sessions currently attached to a live fiber — used as a proxy for "work an update would interrupt." It is not a literal in-flight-turn count; the Session store exposes no narrower public signal, and widening its API for this one caller was not justified.

</details>
