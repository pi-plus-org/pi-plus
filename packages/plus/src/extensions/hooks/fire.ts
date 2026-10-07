/**
 * Fire-and-forget dispatch of settings.json "hooks" command hooks. Spawns
 * each matching hook detached with a JSON payload on stdin and never blocks
 * or fails the agent — hooks are advisory notifications (e.g. ntfy pushes).
 * Commands run via `bash -c` on POSIX (and on Windows when bash is on PATH,
 * e.g. Git Bash); otherwise via cmd.exe.
 */

import { spawn, spawnSync } from "node:child_process";
import { loadSettingsHooks, matcherMatches, type SettingsHook } from "./loader.ts";

/** Extra payload fields (tool_name, permission, ...) merged into the stdin JSON. */
export type HookFields = Record<string, string | undefined>;

const IS_WINDOWS = process.platform === "win32";

/**
 * On Windows, whether `bash` (e.g. Git Bash) is on PATH — probed once.
 * When true, hook commands run through `bash -c` like on POSIX so POSIX
 * hook commands keep working; otherwise they run via cmd.exe (shell:true).
 */
let windowsHasBash: boolean | undefined;

function useBashOnWindows(): boolean {
	if (windowsHasBash === undefined) {
		try {
			windowsHasBash = spawnSync("bash", ["-c", "exit 0"], { stdio: "ignore", windowsHide: true }).status === 0;
		} catch {
			windowsHasBash = false;
		}
	}
	return windowsHasBash;
}

/**
 * Run every hook registered for `event` whose matcher accepts
 * fields.tool_name (absent matcher matches all). Hooks default to
 * loadSettingsHooks(fields.cwd ?? process.cwd()); pass an explicit list in
 * tests. Errors are swallowed.
 *
 * `fields.cwd` (when present) is the session's working directory: it becomes
 * the payload's `cwd`, the working directory hook children spawn in, and the
 * directory used for the project settings lookup. SDK hosts whose process cwd
 * differs from the session cwd (e.g. the desktop app, whose main process runs
 * with cwd "/") must pass it so hooks fire in the right context.
 */
export function fireUserHooks(event: string, fields: HookFields = {}, hooks?: SettingsHook[]): void {
	try {
		const cwd = fields.cwd ?? process.cwd();
		const payload = JSON.stringify({
			cwd,
			hook_event: event,
			ts: new Date().toISOString(),
			...fields,
		});
		const toolName = fields.tool_name;
		for (const hook of hooks ?? loadSettingsHooks(cwd)) {
			if (hook.event !== event) continue;
			if (toolName === undefined ? hook.matcher !== undefined : !matcherMatches(hook.matcher, toolName)) continue;
			// Windows has no bash by default: prefer bash when on PATH (Git Bash),
			// else fall back to cmd.exe via shell:true so hooks still fire.
			const child =
				IS_WINDOWS && !useBashOnWindows()
					? spawn(hook.command, { stdio: ["pipe", "ignore", "ignore"], cwd, shell: true, windowsHide: true })
					: spawn("bash", ["-c", hook.command], { stdio: ["pipe", "ignore", "ignore"], cwd, windowsHide: true });
			child.unref();
			child.stdin?.write(payload);
			child.stdin?.end();
		}
	} catch {
		// Hooks are advisory; never propagate failures into the agent.
	}
}
