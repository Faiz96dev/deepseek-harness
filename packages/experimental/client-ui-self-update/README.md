---
description: "Use and debug the experimental Web sidebar Update button and self-update progress panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-self-update

English | [中文](README.zh.md)

## Summary

This package adds an Update entry to the Web sidebar footer, where a user can check for and apply upstream updates without leaving the browser. It mounts the generated `ctx.remote.selfUpdate` contribution, tracks the current job's live phase and log through its `follow` stream, and reloads the page once the restart completes and the connection re-establishes. Choose it for the experimental source-checkout Web profile; official releases exclude it. This package holds no authoritative state of its own — every fact it shows comes from the Host [`dsh-experimental-self-update`](../self-update/README.md) service.

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

Install the package through [`@deepseek-ai/dsh-experimental-self-update-web-profile`](../self-update-web-profile/README.md) after the stable Web bundle. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields of its own.

### Check and apply an update

The footer button shows a status dot: green when up to date, amber once a check finds commits behind upstream, and blue while a job is running. Opening the panel loads status and the current job (if any); its first line always names the checked-out release version and the short `HEAD` sha. "Check" fetches upstream and reports how far behind it the checkout is. "Update" starts a job immediately — no confirmation step, and no question about active Sessions: the Host flushes and transparently recovers any in-flight turn on its own. A start the Host refuses (another job already running, a dirty working tree, no restart capability) is named in the panel, and a failed Remote call shows its message, so a click never appears to do nothing.

### Watch progress and recover after the restart

While a job runs, the panel shows its current phase and a scrolling log of the underlying git/install/build/verify output; it stays open and cannot be dismissed by an outside click or Escape until the job settles, and it opens on its own the moment a job becomes active — even one started from another tab — so live progress is never lost behind an accidental close. Once the job reaches its restart phase, the panel switches to a "Restarting…" banner; when the physical connection re-establishes afterward, the page reloads automatically so every client bundle is guaranteed current.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export mounts the generated `ctx.remote.selfUpdate` contribution from [`@deepseek-ai/dsh-experimental-self-update/remote`](../self-update/README.md), then registers its locale dictionaries and one sidebar-footer slot entry through Cordis effects. `SelfUpdateController` (the browser-local object layer) holds the current status, job, and accumulated log; it opens exactly one `follow` subscription per panel lifetime, seeded by that stream's baseline frame so a late subscriber, a second tab, or a component remounted by dev-mode HMR always starts from the complete current state rather than a partial one. `onReconnect` exposes the physical `connection/reset` event as a plain callback registration, since components never read `ctx` directly.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Generated Remote mount, locale, and slot registrations |
| [`src/client/controller.ts`](src/client/controller.ts) | Browser-local object layer: status, job, log, and the live follow subscription |
| [`src/client/SelfUpdateAction.tsx`](src/client/SelfUpdateAction.tsx) | Trigger button and panel: status, Check/Update controls, phase list, log |
| [`src/client/slots.ts`](src/client/slots.ts) | The sidebar-footer entry's injected business face and full props type |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [self-update Web profile](../self-update-web-profile/README.md) — the source-checkout bundle that mounts this Client plugin.
- [self-update service](../self-update/README.md) — authoritative job state machine and Remote behavior.
- [Sidebar UI](../../client/ui-sidebar/README.md) — the stable `sidebar.footer.action` slot this package's entry occupies.
- [Experimental packages](../README.md) — incubation status and release exclusion.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser projection registers no model-facing input.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No progress persistence across a full page reload before the restart** — if the tab reloads (or is closed) while a job is running, the panel reopens with only what a fresh `follow` baseline reports; no separate log history view exists.
- **Reload-on-reconnect is unconditional** — any `connection/reset` while the panel believes a restart is in progress triggers `location.reload()`; a spurious reconnect during an otherwise-idle panel does not (the check is gated on the `restarting` view flag).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
