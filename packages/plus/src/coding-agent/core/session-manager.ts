/**
 * pi-plus overlay of the upstream session manager. Upstream packages are never
 * edited: transcript-format behavior (here, an `interactive` host-mode marker in
 * the session header) is layered onto the shared `SessionManager` class and wired
 * in through `loader/redirects.mjs`. Patching rather than subclassing because the
 * constructor is private and the runtime-frequented factories
 * (`create`/`open`/`continueRecent`/`forkFrom`) plus the list builders live inside
 * the upstream module, so a subclass would never be the class the runtime uses.
 * The redirect keeps both spellings on one module instance, so prototype/static
 * patches apply to every manager — including the ones `AgentSessionRuntime`
 * re-creates internally for `/new`, `/cd`, fork and clone. (Same precedent as
 * ./settings-manager.ts.)
 *
 * The marker: `SessionHeader.interactive === false` marks a transcript written by
 * a headless host — CLI print/rpc mode, or an SDK embed with no UI dialog
 * handlers — so user-facing history lists (`pi-plus-desktop` sidebar, search) can
 * hide it. An absent flag means "pre-marker transcript, or a host that never
 * declares its mode (plain `pi`)" and stays visible. Hosts declare their mode
 * process-wide with `setDefaultSessionInteractive()` *before* creating any
 * session, because the session-replacing paths above carry no per-call option;
 * `NewSessionOptions.interactive` overrides for one manager.
 *
 * Consumers that need the behavior import this overlay (plus-api, plus-cli, the
 * cd extension). The read side only decorates the resolved `SessionInfo[]`; the
 * optional `onProgress` partial lists are upstream's and stay undecorated.
 *
 * The overlay also owns the session-history management statics for embedding
 * hosts (`deleteSession` and `search` below): the Override Policy keeps upstream
 * packages pristine, so what began as upstream edits lives here instead, on the
 * same shared class.
 */

export * from "../../../../coding-agent/src/core/session-manager.ts";

import { existsSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import type {
	NewSessionOptions,
	SessionHeader,
	SessionInfo,
	SessionListProgress,
} from "../../../../coding-agent/src/core/session-manager.ts";
import { SessionManager as UpstreamSessionManager } from "../../../../coding-agent/src/core/session-manager.ts";
import { resolvePath } from "../../../../coding-agent/src/utils/paths.ts";

/**
 * The upstream class with the pi-plus statics visible to consumers of this
 * overlay. Same module instance and same object the redirects hand to upstream
 * code — only the static type is widened. The explicit export shadows the
 * star-exported name; the instance-side type still resolves through it.
 */
export const SessionManager: typeof UpstreamSessionManager & {
	/** Removes a persisted session transcript; see the static below. */
	deleteSession(filePath: string): boolean;
	/** Substring search over session history; see the static below. */
	search(
		query: string,
		sessionDir?: string,
		onProgress?: SessionListProgress,
		signal?: AbortSignal,
	): Promise<SessionInfo[]>;
} = UpstreamSessionManager as typeof UpstreamSessionManager & {
	deleteSession(filePath: string): boolean;
	search(
		query: string,
		sessionDir?: string,
		onProgress?: SessionListProgress,
		signal?: AbortSignal,
	): Promise<SessionInfo[]>;
};

/** The instance-side meaning of the shadowed name (unchanged upstream class). */
export type SessionManager = UpstreamSessionManager;

declare module "../../../../coding-agent/src/core/session-manager.ts" {
	interface SessionHeader {
		/**
		 * False when a headless host wrote this transcript (see the file header);
		 * undefined on pre-marker files. Additive optional field: the session
		 * format version is unchanged.
		 */
		interactive?: boolean;
	}
	interface NewSessionOptions {
		/** Per-session override of the process default; see the file header. */
		interactive?: boolean;
	}
	interface SessionInfo {
		/** Copied from the transcript header; undefined when unmarked. */
		interactive?: boolean;
	}
}

/** Process-wide host mode, consulted at header-write time. */
let defaultSessionInteractive = true;

/** Declare whether this process is a human-driven host. Call before any session
 *  is created: it stamps the header of every transcript written afterwards. */
export function setDefaultSessionInteractive(interactive: boolean): void {
	defaultSessionInteractive = interactive;
}

export function getDefaultSessionInteractive(): boolean {
	return defaultSessionInteractive;
}

/** The parts of SessionManager this overlay reaches (upstream privates). */
interface ManagerInternals {
	/** Upstream returns the live header object (or null), not a copy. */
	getHeader(): SessionHeader | null;
	getSessionFile(): string | undefined;
	/** True once this session's file has been written (upstream `private flushed`). */
	flushed?: boolean;
	/** Upstream private: serialize `fileEntries` over the session file. */
	_rewriteFile?: () => void;
}

function stampHeader(manager: ManagerInternals, options?: NewSessionOptions): void {
	const header = manager.getHeader();
	if (!header || header.interactive !== undefined) return;
	header.interactive = options?.interactive ?? getDefaultSessionInteractive();
	// `newSession()` writes nothing, so the stamp rides along on the first real
	// write. `createBranchedSession()` and `forkFrom()` can flush the header while
	// they run; re-serialize through upstream's own writer so the file matches the
	// in-memory entries. Safe because the transcript is append-only, the manager
	// holds every line of it, and this file was just created by this process.
	if (manager.flushed && manager.getSessionFile() && manager._rewriteFile) {
		manager._rewriteFile();
	}
}

const prototype = SessionManager.prototype as unknown as {
	newSession(options?: NewSessionOptions): string | undefined;
	createBranchedSession(leafId: string): string | undefined;
};

const upstreamNewSession = prototype.newSession;
prototype.newSession = function (this: ManagerInternals, options?: NewSessionOptions): string | undefined {
	const sessionFile = upstreamNewSession.call(this, options);
	stampHeader(this, options);
	return sessionFile;
};

const upstreamCreateBranchedSession = prototype.createBranchedSession;
prototype.createBranchedSession = function (this: ManagerInternals, leafId: string): string | undefined {
	const sessionFile = upstreamCreateBranchedSession.call(this, leafId);
	// No options reach a branch: the host driving this process decides visibility.
	stampHeader(this);
	return sessionFile;
};

const statics = SessionManager as unknown as {
	forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
	list(...args: unknown[]): Promise<SessionInfo[]>;
	listAll(...args: unknown[]): Promise<SessionInfo[]>;
};

const upstreamForkFrom = statics.forkFrom;
statics.forkFrom = (
	sourcePath: string,
	targetCwd: string,
	sessionDir?: string,
	options?: NewSessionOptions,
): SessionManager => {
	const manager = upstreamForkFrom.call(
		statics as unknown as typeof SessionManager,
		sourcePath,
		targetCwd,
		sessionDir,
		options,
	);
	// The fork inherits the source transcript's history, not its host: stamp with
	// the caller's override or this process's mode.
	stampHeader(manager as unknown as ManagerInternals, options);
	return manager;
};

/** Headers are one line; a bounded prefix read is enough to spot the marker. */
const HEADER_PREFIX_BYTES = 64 * 1024;

async function readInteractiveFlag(filePath: string): Promise<boolean | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(filePath, "r");
		const buffer = Buffer.alloc(HEADER_PREFIX_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEADER_PREFIX_BYTES, 0);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		const newline = text.indexOf("\n");
		const firstLine = newline === -1 ? text : text.slice(0, newline);
		const parsed: unknown = JSON.parse(firstLine);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const header = parsed as Partial<SessionHeader> & { type?: unknown };
		return header.type === "session" && typeof header.interactive === "boolean" ? header.interactive : undefined;
	} catch {
		// Unreadable, empty, or an oversized header: treat as unmarked (= visible).
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function decorateInteractive(infos: SessionInfo[]): Promise<SessionInfo[]> {
	await Promise.all(
		infos.map(async (info) => {
			const interactive = await readInteractiveFlag(info.path);
			if (interactive !== undefined) info.interactive = interactive;
		}),
	);
	return infos;
}

const upstreamList = statics.list;
statics.list = (...args: unknown[]): Promise<SessionInfo[]> =>
	upstreamList.apply(statics as never, args).then(decorateInteractive);

const upstreamListAll = statics.listAll;
statics.listAll = (...args: unknown[]): Promise<SessionInfo[]> =>
	upstreamListAll.apply(statics as never, args).then(decorateInteractive);

/**
 * Delete a persisted session transcript file. Returns true when the file was
 * removed, false when it did not exist. Throws for paths that do not look
 * like session files (guards against deleting arbitrary files). Does not
 * affect sessions already opened in a SessionManager instance.
 */
SessionManager.deleteSession = (filePath: string): boolean => {
	const resolved = resolvePath(filePath);
	if (!resolved.endsWith(".jsonl")) {
		throw new Error(`Refusing to delete non-session file: ${resolved}`);
	}
	if (!existsSync(resolved)) return false;
	if (!statSync(resolved).isFile()) {
		throw new Error(`Session path is not a file: ${resolved}`);
	}
	rmSync(resolved);
	return true;
};

/**
 * Case-insensitive substring search over session history: matches the session
 * name, the first user message, or any user/assistant message text
 * (`SessionInfo.allMessagesText`). Returns full `SessionInfo` entries ordered
 * by last activity, newest first — same shape as `listAll()`, and decorated
 * with the interactive marker because it delegates to the patched `listAll`.
 * An empty or whitespace-only query returns `[]`.
 * @param query Search text (trimmed)
 * @param sessionDir Optional session directory to scope the search to; defaults to all project dirs.
 * @param onProgress Optional callback for progress updates (loaded, total)
 * @param signal Optional abort signal
 */
SessionManager.search = async (
	query: string,
	sessionDir?: string,
	onProgress?: SessionListProgress,
	signal?: AbortSignal,
): Promise<SessionInfo[]> => {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const sessions = sessionDir
		? await SessionManager.listAll(sessionDir, onProgress, signal)
		: await SessionManager.listAll(onProgress, signal);
	return sessions.filter(
		(session) =>
			(session.name?.toLowerCase().includes(needle) ?? false) ||
			session.firstMessage.toLowerCase().includes(needle) ||
			session.allMessagesText.toLowerCase().includes(needle),
	);
};
