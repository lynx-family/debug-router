---
name: debug-router
description: Use when an agent needs to discover Debug Router devices or clients, send raw CDP or App protocol messages, or listen for all protocol events on Android, iOS, Harmony, or Desktop.
---

# Debug Router CLI

Use `debug-router` for raw DebugRouterConnector access. It does not support Network targets.

Before first use, run `debug-router --version`. If the command is unavailable,
stop and ask the user to install the CLI with:

```bash
npm install -g @lynx-js/debug-router-connector
debug-router install-skill
```

## Workflow

1. Run `debug-router list` first.
2. Parse stdout as JSON and copy an exact `deviceId` or `clientId`.
3. Never guess IDs. If multiple clients exist, select an exact one.
4. Run `send` for a protocol request or `listen` for all events.
5. Parse stdout as JSON for `list`/`send` and JSONL for `listen`. Treat stderr as diagnostics.

```bash
debug-router list --platform android
debug-router send --client-id 'device:8901' --type cdp --method Runtime.enable --params '{}'
debug-router listen --client-id 'device:8901' --timeout 10000
```

`--session-id` is valid only for CDP and defaults to `-1`. App requests always use `-1`. Do not guess methods, parameters, or session IDs.

CLI invocations serialize and wait up to 60 seconds by default. A listener without `--timeout` blocks other CLI calls until it exits.

If stderr reports `CONNECTOR_BUSY_TIMEOUT` or `CONNECTOR_PREEMPTED`, explain that taking ownership disrupts the other DebugRouterConnector and ask the user for explicit confirmation. Only after confirmation may you re-run the exact original command once with `--takeover`. Never add `--takeover` automatically and never retry it in a loop.

Before sending a method that clearly changes app or page state, obtain user approval. Passive discovery and listening are observational.
