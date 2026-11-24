# plus-p2

Fork-only plugins for p2 (pi-plus-desktop). `apps/p2` is upstream-owned and must not be edited, so extensions that
change p2's behavior live here and load through p2's own global-plugin mechanism: p2 scans `<data>/plugins` at
startup and loads every plugin there as the owner (see `apps/p2/docs/plugin-loading.md` — "global" plugins).

## Plugins

- **`plugins/plus-mcp-tools`** — MCP tools in the editor's slash completion. Typing `/` in the TUI editor lists the
  viewed session's MCP tools as `mcp__<server>__<tool>` alongside the slash commands, with each tool's description.
  Picking one inserts `/mcp__server__tool `, which names no command and no expansion, so the composer submits it to
  the session's conversation as typed — a regular prompt telling the agent which MCP tool to use. The offered tools
  are the ones the session's workers lease from the upstream MCP plugin's manager (failed instances excluded), so
  completion only offers tools the agent can actually call.

  - `contract.ts` — the `plus.mcp-tools` remote: a participant view of the session's tool list, served on the server.
  - `server.ts` — derives the view from the upstream `McpManager` (instances × the session's leases). The manager
    handle is imported from `p2:plugins/mcp/contract.ts` — cross-plugin imports are contract modules only
    (`docs/plugin-loading.md` 14.4).
  - `tui.ts` — contributes a `TuiSlashSource` keyed `plus-mcp-tools`; `SlashCompletion` merges it automatically.

## Install

```sh
node apps/plus-p2/install.mjs   # symlinks into <P2_DATA_DIR|~/.pi/p2>/plugins/plus-mcp-tools
```

Restart p2 after installing or editing (the server also exposes a plugin reload for the global root). Remove the
symlink to uninstall.

## Check

```sh
npm run check -w @pi/p2-plugins # or: cd apps/plus-p2 && npm run check
```
