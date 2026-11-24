#!/usr/bin/env node
// Links the fork's p2 plugins into p2's global plugin root (<P2_DATA_DIR|~/.pi/p2>/plugins). p2 scans that root at
// startup; global plugins run as the owner, so a symlink into this repo is the whole "install".
import { existsSync } from "node:fs";
import { mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = process.env.P2_DATA_DIR ?? join(homedir(), ".pi", "p2");
const pluginsDir = join(dataDir, "plugins");
const source = fileURLToPath(new URL("./plugins/plus-mcp-tools", import.meta.url));
const target = join(pluginsDir, "plus-mcp-tools");

if (!existsSync(source)) {
	console.error(`plugin source not found: ${source}`);
	process.exit(1);
}
await mkdir(pluginsDir, { recursive: true });
try {
	const link = await readlink(target);
	if (resolve(link) === resolve(source) && existsSync(target)) {
		console.log(`already linked: ${target} -> ${source}`);
		process.exit(0);
	}
} catch {
	// Not a symlink: fall through and replace.
}
await rm(target, { recursive: true, force: true });
await symlink(source, target, "dir");
console.log(`linked ${target} -> ${source}`);
console.log("restart p2 to load it");
