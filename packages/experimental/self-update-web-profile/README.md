---
description: "Add the experimental self-update Update button to a source-checkout Web profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-self-update-web-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-self-update-web-profile` is the private Web layer for [self-update](../self-update/README.md): a sidebar Update button that fetches, merges, rebuilds, and restarts a source-checkout deployment. Add it after `@deepseek-ai/dsh-web-app` to mount both the Host Remote service and its browser controls in one step. Official releases exclude this package, so it is available only from a source checkout, and its configuration is deployment-specific (absolute paths for this exact machine's checkout and `$DSH_HOME`).

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

### Install into a profile

From this repository checkout, add the Web layer to an initialized `web` profile:

```sh
pnpm dsh plugin --profile web add ./packages/experimental/self-update-web-profile
```

This activates this package's declared patch, mounting both the `self-update` Host row and the `ui-self-update` Client row. The profile must be restarted (`pm2 restart dsh-web` under a pm2-supervised deployment) to pick up the new bundle. Removing the package with `dsh plugin --profile web remove @deepseek-ai/dsh-experimental-self-update-web-profile` removes the Web layer from the profile's ordered bundle list.

### Before installing: edit `cordis.patch.yml` for this deployment

Every field under the `self-update` row's `config` is an absolute, deployment-specific value: `repoRoot` (the git checkout this process runs from), `extraPathDirs` (directories a supervisor's minimal `PATH` is missing, most commonly wherever `pnpm` itself lives), `backupRoot`, `logDir`, `sessionsDir`, `storagesDir`, and `attachmentsDir` (this deployment's `$DSH_HOME` subdirectories). Copy `cordis.patch.yml` into a profile-level `--patch` overlay or edit it in place before installing on a different machine or checkout; see [`dsh-experimental-self-update`'s Configuration](../self-update/README.md#configuration) for every field's meaning.

### What you get

The sidebar footer gains an Update button with a commits-behind badge. Opening it shows the current commit, a Check/Update control pair, live phase and log output while a job runs, and an automatic reload once the restart completes. [`@deepseek-ai/dsh-experimental-client-ui-self-update`](../client-ui-self-update/README.md) owns those browser interactions and mounts the generated Client Remote namespace used to reach the Host [`dsh-experimental-self-update`](../self-update/README.md) service.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml). Applied after `dsh-web-app`, its single `insert` entry adds two rows: `self-update` (the Host Remote service, with this deployment's configuration) and `ui-self-update` (the Client plugin that mounts the generated Remote and the sidebar button). This static bundle holds no mutable state and installs no runtime invariant of its own.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered Web patch containing the `self-update` and `ui-self-update` rows |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| [`src/invariant.ts`](src/invariant.ts) | Empty invariant companion for the static bundle |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and release exclusion.
- [self-update Host service](../self-update/README.md) — the Remote namespace, job state machine, and configuration reference.
- [self-update browser UI](../client-ui-self-update/README.md) — the sidebar button, panel, and reconnect-reload behavior.
- [Web bundle](../../bundle/web-app/README.md) — the stable browser layer this patch extends.

-----

<a id="model-experience"></a>
## Model Experience

None. Neither row this bundle inserts registers a tool, prompt section, or Session event; the Host Remote service and its browser controls are entirely operator-facing.

#### KV Cache effect

This Web bundle adds no model request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Deployment-specific configuration** — every absolute path in `cordis.patch.yml` names this exact machine's checkout and `$DSH_HOME`; moving to another machine requires editing them (see "Before installing" above).
- **Ordered composition** — `dsh-base`, `dsh-web-app`, and this package must remain in that order.
- **Source-checkout only** — official CLI, Web, npm, and Python release payloads exclude this private package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
