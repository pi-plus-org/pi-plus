#!/usr/bin/env node
// Pre-commit scope gate for the pi-plus fork: every staged path must live
// under one of the fork's own packages. Core packages (and everything else
// upstream owns) stay pristine so upstream syncs never conflict.
// Merge commits don't run pre-commit, so "chore: sync with upstream/main"
// merges remain possible; this gate covers everyday commits, cherry-picks and
// amends.

import { spawnSync } from "node:child_process";

const ALLOWED_PREFIXES = ["packages/plus/", "packages/hub/", "packages/plus-cli/", "packages/plus-api/", "packages/plus-tui/"];
// The gate's own infrastructure: without these it could never be committed.
const ALLOWED_PATHS = new Set(["scripts/check-fork-scope.mjs", ".husky/pre-commit"]);

const staged = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACDMRT"], { encoding: "utf8" });
if (staged.error) {
	console.error("check-fork-scope: could not list staged files:", staged.error.message);
	process.exit(1);
}

const files = staged.stdout.split("\n").filter(Boolean);
const violations = files.filter(
	(file) => !ALLOWED_PATHS.has(file) && !ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix)),
);

if (violations.length === 0) process.exit(0);

console.error("check-fork-scope: fork commits may only touch the extended packages:");
console.error("  packages/plus, packages/hub, packages/plus-cli, packages/plus-api, packages/plus-tui");
console.error("");
console.error("Off-path staged files (restore them or move the change into an extended package):");
for (const file of violations) console.error(`  ${file}`);
console.error("");
console.error("Upstream syncs stay exempt: git does not run pre-commit on merge commits.");
process.exit(1);
