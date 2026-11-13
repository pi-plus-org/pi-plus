<p align="center">
  <img alt="pi-plus logo" src="assets/pi-plus-logo.png" width="128" />
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/pi-plus"><img alt="npm" src="https://img.shields.io/npm/v/pi-plus?style=flat-square" /></a>
  <a href="https://nodejs.org"><img alt="node" src="https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?style=flat-square" /></a>
</p>

# pi-plus

pi-plus layers a full-featured agent experience on top of the minimal [pi](https://pi.dev) harness — plan mode, subagents, task lists, persistent memory, hooks, auto-titled sessions, context-guarded compaction, reasoning effort levels, and named provider profiles — and ships it as a single global command: **`pipi`**.

Everything pi-plus adds lives in this repo's `packages/plus*` layer; the upstream pi packages stay pristine so they can be resynced without merge conflicts. Upstream fixes propagate automatically.

<p align="center">
  <img alt="pi-plus CLI session: welcome banner, plain tool blocks, recap-titled footer" src="assets/pi-plus-demo.gif" width="820" />
</p>

## Getting started

```bash
npm install -g --ignore-scripts pi-plus
```

This installs `pipi` (it never claims pi's own `pi` command). Requires Node.js 22.19 or newer.

Add a provider profile (interactive OAuth / API-key sign-in included):

```bash
pipi profile add work -p anthropic --sign-in
pipi use work
```

Then start a session wherever you want it to work:

```bash
cd /path/to/project
pipi
```

## Profiles

pi-plus wraps pi with **hub profiles**: named provider/model/thinking/token bundles stored in `~/.pi/profiles.json`, each materialized into an isolated agent dir under `~/.pi/pi-hub/profiles/<name>/`.

| Command | Effect |
|---------|--------|
| `pipi profile add <name> -p <provider>` | Create a profile; add `--sign-in` for the provider's interactive login |
| `pipi profile list / view / default` | Inspect profiles, switch the default |
| `pipi profile update / remove / rename` | Manage existing profiles |
| `pipi use <name>` / `pipi unuse` | Pin the current project to a profile, or unpin |
| `pipi --as <name>` | Run one session under a specific profile |

`pipi profile add` with no credential invokes the provider's interactive login (OAuth page or API-key setup) against the profile dir; the TUI `/login` redirects to this flow.

## What you get on top of pi

- **Plan mode** — `/plan` (or Shift+Tab) engages a read-only mode with a writable session plan file and a safe-bash allowlist, so plans get reviewed before edits.
- **Subagents** — a `Subagent` tool for delegated parallel work.
- **Task lists** — `/tasks` structured todo tracking across the session.
- **Memory** — `/memory` persistent notes that survive compaction.
- **Ask-user** — the agent can surface interactive clarification questions instead of guessing.
- **Hooks** — fire shell commands on session lifecycle events, run in the session cwd.
- **Permission modes** — Claude Code–style gating on every tool call: `bypass` / `accept-edits` / `plan`, via `/permissions`, Shift+Tab, or a host-driven mode holder.
- **Context guard** — per-message threshold detection: warnings, blocking limit, auto-compact tuned to the effective context window, 3-failure circuit breaker, idle micro-compaction of stale tool results.
- **Compaction** — single full-conversation summaries (Claude-style 9-section prompt) with post-compact re-injection of recently read files, the active plan, and invoked skills.
- **Reasoning effort** — `low` / `medium` / `high` / `max` levels, adaptive thinking, `ultrathink` keyword; footer shows the active level.
- **Recap auto-titles** — the session gets a ≤8-word title after the first exchange and every compaction; it lands in the tab title and the resume list until you rename it manually.
- **Plain tool blocks** — tool status reads as text, never colored blocks.
- **Tab title + spinner** — terminal tab brands as `pi+ - [session title -] dir` with a braille busy spinner.
- **Vim modal editing** — `/vim` or `"vim": true`: insert/normal/visual modes, motions with counts, `d c y` operators, undo/redo, prompt search.
- **Settings rows** — `/settings` gains auto-compact threshold, context floor, and context-window cap.
- **Shell completion** — `pipi completion bash|zsh` covers hub subcommands (with dynamic profile names) plus pi's native commands.

The welcome banner, compact/plain degradation on narrow terminals, and `resumed <id> · <title>` on resume/fork come with the UI layer.

## Useful environment variables

| Var | Effect |
|-----|--------|
| `PI_EFFORT_LEVEL` | `off`/`auto`/`low`/`medium`/`high`/`max` reasoning effort |
| `PI_MAX_CONTEXT_TOKENS` | Cap the model context window |
| `PI_AUTOCOMPACT_PCT_OVERRIDE` | Auto-compact threshold as % of the effective window |
| `PI_DISABLE_AUTO_COMPACT` | Disable threshold-triggered compaction |

The full table (plus compaction/thinking knobs) lives in [`packages/plus/README.md`](packages/plus/README.md).

## Build apps on it

Library hosts embedding pi in-process use **`pi-plus-sdk`** ([`packages/plus-api`](packages/plus-api)):

```bash
npm install --ignore-scripts pi-plus-sdk
```

## Development

```bash
npm install --ignore-scripts   # never runs lifecycle scripts
npm run build:offline          # build all packages, reusing existing model data
npm run check                  # biome + pinned deps + shrinkwrap + tsgo typecheck

cd packages/plus-cli
./pipi --no-env                # run pipi from TypeScript sources with the override layer active
```

Tests: `npx vitest run` inside `packages/plus`, `packages/plus-cli`, or `packages/plus-api`; `./test.sh` at the repo root runs the full non-e2e suite in an isolated HOME.

### Using local packages outside the monorepo

Build every public package into one coherent local artifact set:

```bash
npm run pack:packages -- --out .artifacts/pi-packages
```

This refreshes model data before building `pi-ai`. To avoid network access when
model data is already hydrated, pass `--offline-model-data`.

Then configure an external project to consume one package and resolve all of
its Pi dependencies from the same artifact set. npm is the default:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-durable \
  --package @earendil-works/pi-agent-core
cd ../my-project
npm install --ignore-scripts
```

For a pnpm project, point `--consumer` at the workspace root:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-agent-core \
  --package-manager pnpm
cd ../my-project
pnpm install --ignore-scripts
```

Repeat `--package` for each direct dependency. The command updates the
consumer's `package.json` with content-addressed local `file:` references. It
writes transitive overrides to `package.json` for npm or `pnpm-workspace.yaml`
for pnpm. Keep the artifact directory available while installing or updating
the consumer. Re-run both commands after changing Pi source.

## Building standalone binaries from release source

### Repo layout

| Path | Description |
|------|-------------|
| [`packages/plus`](packages/plus) | Shared override core: context detection, compaction, reasoning, the ten non-TUI extensions |
| [`packages/plus-cli`](packages/plus-cli) | The `pi-plus` npm artifact: `pipi` CLI — hub profiles, completion, banner, vim, tab title |
| [`packages/plus-api`](packages/plus-api) | The `pi-plus-sdk` npm artifact: embeddable library entry over the shared core |
| [`packages/hub`](packages/hub) | Named pi profiles with per-profile materialized agent dirs |
| `packages/ai`, `packages/agent`, `packages/coding-agent`, `packages/tui`, … | Upstream pi packages — kept pristine; overrides are wired in only through loader/bundle redirects |

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent install lock.
- The pi.dev installer installs from `packages/coding-agent/install-lock/`, generated from the root lockfile, to pin transitive deps. The npm package does not pin transitive deps.
- Local release smoke tests and npm publication use the same tarball packer; npm publishes the validated tarballs rather than repacking workspace directories.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Install lock generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT
