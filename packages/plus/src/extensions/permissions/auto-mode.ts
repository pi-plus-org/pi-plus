/**
 * Auto-mode policy for pi-plus (ported from Claude Code's auto permission mode).
 *
 * Auto mode replaces "ask the human" with "ask the model": everything the gate
 * has to judge goes to an action classifier that returns allow/block. This
 * module holds the parts that must NOT be delegated to the classifier, because
 * a wrong verdict there is the expensive kind:
 *
 * - `autoModeWriteDenial` — an unconditional deny-list of paths whose contents
 *   decide what the agent is allowed to do next (VCS internals, agent/editor
 *   config directories, shell and git startup files, the project's AGENTS.md
 *   and settings.json). Claude Code marks the same set "not classifier-approvable,
 *   no settings-based exceptions" (`src/utils/permissions/filesystem.ts`), so
 *   the gate applies it before the model is ever consulted.
 * - `DenialTracker` — Claude Code's denial tracking (`denialTracking.ts`): when
 *   the classifier keeps blocking, that is a signal the session is fighting its
 *   mode, not that the model is right N times in a row. We surface it once per
 *   streak instead of silently blocking forever.
 *
 * Reads are deliberately unrestricted here: reading a file is usually the only
 * way to learn what it guards, and this gate stops changes, not knowledge.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

/** Session-relative or absolute path, normalized for comparison. */
function absolute(path: string, cwd: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** True when `child` is `root` itself or lives inside it. */
export function isWithin(root: string, child: string): boolean {
	const rel = relative(resolve(root), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Directory names that never receive writes in auto mode. These hold agent,
 * editor, and version-control state: rewriting them rewrites the rules the
 * agent runs under, which is exactly what a permission gate must not outsource.
 */
const PROTECTED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	".pi",
	".claude",
	".cursor",
	".vscode",
	".idea",
	".agents",
	".codex",
	".husky",
]);

/** Startup and client-config files that never receive writes in auto mode. */
const PROTECTED_FILES = new Set([
	".gitconfig",
	".gitmodules",
	".bashrc",
	".bash_profile",
	".bash_login",
	".zshrc",
	".zlogin",
	".zshenv",
	".profile",
	".env",
	".mcp.json",
	"config",
]);

/**
 * Files that steer every later session. Denied only directly in the project
 * root — a dependency that happens to ship `AGENTS.md` is fair game.
 */
const PROTECTED_PROJECT_FILES = new Set(["AGENTS.md", "settings.json"]);

/**
 * Why writing `path` is not allowed in auto mode, or `undefined` when it is.
 * Independent of the classifier verdict by design.
 */
export function autoModeWriteDenial(path: string, cwd: string): string | undefined {
	const target = absolute(path, cwd);
	const segments = target.startsWith(sep) ? target.slice(1).split(sep) : target.split(sep);
	const file = segments[segments.length - 1] ?? "";
	const directories = segments.slice(0, -1);

	const protectedDir = directories.find((dir) => PROTECTED_DIRECTORIES.has(dir));
	if (protectedDir) {
		return `auto mode does not write into ${protectedDir}/: it holds the configuration this agent runs under`;
	}
	// A bare "config" is only meaningful inside a dot-directory (e.g. ~/.gitconfig
	// lives as .gitconfig, ~/.config/git/config inside .config).
	if (PROTECTED_FILES.has(file) && (directories.length > 0 || file.startsWith("."))) {
		return `auto mode does not write ${file}: shell, git, or client startup configuration`;
	}
	if (PROTECTED_PROJECT_FILES.has(file) && isWithin(cwd, target) && withinProjectRoot(target, cwd)) {
		return `auto mode does not rewrite ${file} at the project root: it steers every later session`;
	}
	return undefined;
}

/** True when `target` is a direct child of `cwd`. */
function withinProjectRoot(target: string, cwd: string): boolean {
	const rel = relative(resolve(cwd), resolve(target));
	return rel !== "" && !rel.includes(sep) && !rel.startsWith("..");
}

/** Path-argument keys the file tools use (pi's read/edit/write input). */
const PATH_KEYS = ["path", "file", "filePath", "file_path", "notebookPath"] as const;

/**
 * Path arguments of a tool call, resolved against the session cwd.
 *
 * Shell tools return nothing on purpose: their paths are inside a command
 * string, and guessing them with string matches would turn the gate into a
 * denylist the classifier is meant to replace. Unknown custom tools likewise
 * return nothing and go to the classifier.
 */
export function toolInputPaths(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	if (toolName === "bash" || toolName === "powershell" || toolName === "subagent") return [];
	const found: string[] = [];
	for (const key of PATH_KEYS) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) found.push(value);
	}
	const files = input.files;
	if (Array.isArray(files)) {
		for (const item of files) {
			if (typeof item === "string" && item.trim()) found.push(item);
			else if (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string") {
				found.push((item as { path: string }).path);
			}
		}
	}
	return found.map((path) => absolute(path, cwd));
}

/**
 * Consecutive-deny tracking, mirroring Claude Code's
 * `DENIAL_TRACKING_MAX_CONSECUTIVE`: a classifier that blocks one action after
 * another is evidence the session and the mode disagree. The counter resets on
 * any allow. We never auto-revert the mode (Claude Code switches back to
 * prompting); we tell the user once per streak so they can pick a mode.
 */
export class DenialTracker {
	private consecutive = 0;
	private notified = false;
	readonly maxConsecutive: number;

	constructor(maxConsecutive: number = 3) {
		this.maxConsecutive = maxConsecutive;
	}

	/** Record a blocked action; returns the streak length. */
	recordBlock(): number {
		this.consecutive += 1;
		return this.consecutive;
	}

	/** Record an allowed action: the streak is over. */
	recordAllow(): void {
		this.consecutive = 0;
		this.notified = false;
	}

	/** True exactly once per streak, so the user is nagged at most once. */
	shouldNotify(): boolean {
		if (this.consecutive < this.maxConsecutive || this.notified) return false;
		this.notified = true;
		return true;
	}
}
