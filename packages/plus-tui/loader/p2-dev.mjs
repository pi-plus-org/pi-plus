// Runs the pi-plus p2 dev host with the plus-tui redirects applied. p2's dev script spawns its server
// (and the TUI worker) via `node --import src/source.ts`, and spawned processes inherit the environment,
// so NODE_OPTIONS preloads the redirect hooks into every p2 process alongside p2's own source loader.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const loaderDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(loaderDir, "..", "..");
const registerFlag = `--import ${pathToFileURL(join(loaderDir, "register.mjs")).href}`;
const nodeOptions = process.env.NODE_OPTIONS ? `${registerFlag} ${process.env.NODE_OPTIONS}` : registerFlag;

const child = spawn("npm", ["run", "dev", "--", ...process.argv.slice(2)], {
	cwd: join(repoRoot, "apps", "p2"),
	env: { ...process.env, NODE_OPTIONS: nodeOptions },
	stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 1));
