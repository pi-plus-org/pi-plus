/**
 * MCP server management for SDK hosts: the programmatic equivalent of `pi mcp list/add/remove/login/logout`.
 *
 * pi-plus disables the TUI's `/mcp` commands, so hosts (desktop frontends, IDE adapters) manage MCP
 * servers through this module instead. Config CRUD reads and writes the same two files pi loads
 * (`<agentDir>/mcp.json` and, for trusted projects, `<cwd>/.pi/mcp.json`); status checks and OAuth
 * sign-in reuse pi's own MCP runtime (`extensions/mcp/runtime.ts`), so connection semantics,
 * keyring/`mcp-auth.json` storage, and the callback-server flow are not duplicated here.
 *
 * The upstream modules imported below are not plus redirect targets, and the wrapper-relevant ones
 * (the `loadMcpConfig`/`addMcpServerConfig`/... config functions and `validateMcpServerConfig`) are
 * not exported from the upstream barrel at all, so deep imports are the only option; runtime values
 * that the barrel does export are still imported through it, matching the packages.ts convention.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FileAuthStorageBackend } from "../../coding-agent/src/core/auth-storage.ts";
import { getMcpToolExposure, validateMcpServerConfig } from "../../coding-agent/src/core/mcp-servers.ts";
import {
	addMcpServerConfig,
	loadMcpConfig,
	type McpServerConfigPatch,
	removeMcpServerConfig,
	updateMcpServerConfig,
} from "../../coding-agent/src/extensions/mcp/config.ts";
import {
	McpOAuthCredentialStore,
	McpSignInCancelledError,
	type McpSignInPrompt,
	signInMcpServer,
} from "../../coding-agent/src/extensions/mcp/oauth.ts";
import {
	createDefaultTransport,
	McpServerConnection,
	McpServerLog,
} from "../../coding-agent/src/extensions/mcp/runtime.ts";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type LoadedMcpConfig,
	type McpServerConfig,
	type McpServerEntry,
} from "../../coding-agent/src/index.ts";

/** Host options locating the two MCP config files. */
export interface PlusMcpOptions {
	/** Project root whose `.pi/mcp.json` participates. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Pi agent directory holding the global `mcp.json`. Defaults to `getAgentDir()`. */
	agentDir?: string;
	/** Whether the project may contribute local MCP config. Defaults to true; set from ProjectTrustStore. */
	projectTrusted?: boolean;
}

/** Options for writes that choose between the global and the project file. */
export interface PlusMcpEditOptions extends PlusMcpOptions {
	/** true targets the project `<cwd>/.pi/mcp.json`; false/undefined the global `<agentDir>/mcp.json`. */
	local?: boolean;
}

/** Options for updates that need to find the file actually defining the server. */
export interface PlusMcpUpdateOptions extends PlusMcpOptions {
	/**
	 * Where to write the patch. Omitted: the file that defines or overrides the server (a project
	 * override wins over the global entry, like pi's `/mcp enable|disable`). "project" writes (or
	 * creates, as an override) the entry in the project file; "user" forces the global file.
	 */
	scope?: "user" | "project";
}

interface ResolvedMcpOptions {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}

function resolveMcpOptions(options: PlusMcpOptions): ResolvedMcpOptions {
	return {
		cwd: resolve(options.cwd ?? process.cwd()),
		agentDir: resolve(options.agentDir ?? getAgentDir()),
		projectTrusted: options.projectTrusted ?? true,
	};
}

function requireProjectTrusted(resolved: ResolvedMcpOptions): void {
	if (!resolved.projectTrusted) {
		throw new Error(
			`Project is not trusted: "${resolved.cwd}". Enable project scope (projectTrusted) to edit ${join(resolved.cwd, CONFIG_DIR_NAME, "mcp.json")}.`,
		);
	}
}

/**
 * The OAuth credential store for the resolved agent directory. With an explicit `agentDir` the
 * backing file and lock directory move with it; otherwise pi's default store is used.
 */
function mcpCredentialStore(resolved: ResolvedMcpOptions): McpOAuthCredentialStore {
	const defaultDir = resolve(getAgentDir());
	if (resolved.agentDir === defaultDir) return new McpOAuthCredentialStore();
	return new McpOAuthCredentialStore(
		new FileAuthStorageBackend(join(resolved.agentDir, "mcp-auth.json")),
		resolved.agentDir,
	);
}

function mcpLog(resolved: ResolvedMcpOptions): McpServerLog {
	return new McpServerLog(join(resolved.agentDir, "mcp.log"));
}

function findMcpEntry(name: string, resolved: ResolvedMcpOptions): McpServerEntry {
	const config = loadMcpConfig(resolved);
	const entry = config.servers.find((server) => server.name === name);
	if (!entry) {
		const configured = config.servers.map((server) => server.name).join(", ") || "none";
		throw new Error(`No MCP server named "${name}". Configured: ${configured}.`);
	}
	return entry;
}

/** Absolute paths of the two mcp.json files for these options. */
export function getMcpConfigPaths(options: PlusMcpOptions = {}): { global: string; project: string } {
	const resolved = resolveMcpOptions(options);
	return { global: join(resolved.agentDir, "mcp.json"), project: join(resolved.cwd, CONFIG_DIR_NAME, "mcp.json") };
}

/**
 * Load the merged MCP config pi would start a session with: global entries, trusted-project entries
 * (overrides win), parse/validation errors, and the per-tool exposure rules. Never throws on a broken
 * file; unreadable or invalid entries come back in `errors` like `pi mcp list` reports them.
 */
export function listMcpServers(options: PlusMcpOptions = {}): LoadedMcpConfig {
	return loadMcpConfig(resolveMcpOptions(options));
}

/**
 * Validate a raw mcp.json entry the way pi's loader does, without writing it. Hosts can use this to
 * check a form before calling addMcpServer. Returns the validated config, or a human-readable error
 * string (pi's own wording).
 */
export function validateMcpServer(name: string, raw: unknown): McpServerConfig | string {
	return validateMcpServerConfig(name, raw);
}

/**
 * Add or replace a server in the scope's mcp.json (global by default; `local: true` needs a trusted
 * project). `config` is validated first — an invalid entry throws instead of writing.
 */
export function addMcpServer(
	name: string,
	config: McpServerConfig,
	options: PlusMcpEditOptions = {},
): { replaced: boolean; path: string } {
	const validated = validateMcpServerConfig(name, config);
	if (typeof validated === "string") throw new Error(`Invalid MCP server config: ${validated}`);
	const resolved = resolveMcpOptions(options);
	const path = options.local ? getMcpConfigPaths(resolved).project : getMcpConfigPaths(resolved).global;
	if (options.local) requireProjectTrusted(resolved);
	const replaced = addMcpServerConfig(path, name, validated);
	return { replaced, path };
}

/** Remove a server from the scope's mcp.json. Does not touch OAuth credentials. */
export function removeMcpServer(name: string, options: PlusMcpEditOptions = {}): { removed: boolean; path: string } {
	const resolved = resolveMcpOptions(options);
	const path = options.local ? getMcpConfigPaths(resolved).project : getMcpConfigPaths(resolved).global;
	if (options.local) requireProjectTrusted(resolved);
	return { removed: removeMcpServerConfig(path, name), path };
}

/**
 * Patch how an existing server is exposed (`enabled`, `exposure`) without changing its connection
 * config, like pi's `/mcp enable|disable|expose`. `tools` and `toolExposure` are not accepted here.
 */
export function updateMcpServer(
	name: string,
	patch: McpServerConfigPatch,
	options: PlusMcpUpdateOptions = {},
): { path: string } {
	const resolved = resolveMcpOptions(options);
	const entry = findMcpEntry(name, resolved);
	if (entry.scope === "extension") {
		throw new Error(`MCP server "${name}" is registered by an extension and cannot be edited in mcp.json.`);
	}
	const paths = getMcpConfigPaths(resolved);
	if (options.scope === "project") {
		requireProjectTrusted(resolved);
		updateMcpServerConfig(paths.project, name, patch, { override: true });
		return { path: paths.project };
	}
	if (options.scope === "user") {
		updateMcpServerConfig(paths.global, name, patch, { override: false });
		return { path: paths.global };
	}
	const path = entry.override ?? entry.source;
	updateMcpServerConfig(path, name, patch, { override: path === paths.project });
	return { path };
}

/** One server as `pi mcp list` reports it: static config plus live connection state when enabled. */
export interface McpServerStatus {
	name: string;
	scope: "global" | "project" | "extension";
	/** File defining the entry. */
	source: string;
	/** File overriding it, when a project override exists. */
	override?: string;
	enabled: boolean;
	/** Server-level exposure (`"codemode" | "deferred" | "direct" | "hidden"`; pi defaults to "codemode"). */
	exposure: string;
	/** `"stdio"` or the server URL. */
	transport: string;
	/**
	 * Connection state: "disabled" when not enabled; otherwise after a connect attempt
	 * "connected", "needs-auth" (sign in with loginMcpServer), "failed" (see error), or "disconnected".
	 */
	state: "disabled" | "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";
	/** Registered tool names (namespaced), empty unless connected. */
	tools: string[];
	/** Per-tool exposure overrides that differ from `exposure`. */
	toolExposure?: Record<string, string>;
	resources?: boolean;
	error?: string;
}

/** Result of {@link checkMcpServers}. */
export interface PlusMcpCheckResult {
	servers: McpServerStatus[];
	/** Config-load problems (unreadable file, invalid entries). */
	errors: string[];
	/** Set when the project config exists but the project is not trusted. */
	note?: string;
}

function describeMcpTransport(entry: McpServerEntry): string {
	const config = entry.config;
	if (config && "url" in config) return config.url;
	if (config && "command" in config) return [config.command, ...(config.args ?? [])].join(" ");
	return "unknown";
}

function createMcpConnection(
	entry: McpServerEntry,
	resolved: ResolvedMcpOptions,
	credentials: McpOAuthCredentialStore,
): McpServerConnection {
	return new McpServerConnection({
		entry,
		cwd: resolved.cwd,
		createTransport: createDefaultTransport,
		credentials,
		log: mcpLog(resolved),
		onTools: () => {},
	});
}

/**
 * Connect to every enabled MCP server and report its state and tools, in parallel, like
 * `pi mcp list`. Servers that need sign-in come back `needs-auth`; unreachable ones `failed` with
 * the recorded error. Disabled servers are reported without any connection attempt.
 */
export async function checkMcpServers(options: PlusMcpOptions = {}): Promise<PlusMcpCheckResult> {
	const resolved = resolveMcpOptions(options);
	const loaded = loadMcpConfig(resolved);
	const credentials = mcpCredentialStore(resolved);
	const servers = await Promise.all(
		loaded.servers.map(async (entry): Promise<McpServerStatus> => {
			const status: McpServerStatus = {
				name: entry.name,
				scope: entry.scope ?? "global",
				source: entry.source,
				...(entry.override ? { override: entry.override } : {}),
				enabled: entry.config.enabled !== false,
				exposure: entry.config.exposure ?? "codemode",
				transport: describeMcpTransport(entry),
				state: "disabled",
				tools: [],
			};
			if (!status.enabled) return status;
			const connection = createMcpConnection(entry, resolved, credentials);
			try {
				try {
					await connection.getClient();
				} catch {
					// The connection records `state`/`error`; the report carries them below.
				}
				status.state = connection.state;
				status.tools = connection.tools.map((tool) => tool.name);
				status.resources = connection.hasResources;
				const toolExposure: Record<string, string> = {};
				for (const tool of connection.tools) {
					const exposure = getMcpToolExposure(entry.config, tool.name);
					if (exposure !== status.exposure) toolExposure[tool.name] = exposure;
				}
				if (Object.keys(toolExposure).length > 0) status.toolExposure = toolExposure;
				if (connection.state !== "connected" && connection.error) status.error = connection.error;
			} finally {
				await connection.close();
			}
			return status;
		}),
	);
	const projectPath = getMcpConfigPaths(resolved).project;
	const note =
		!resolved.projectTrusted && existsSync(projectPath)
			? "Project MCP config is ignored: the project is not trusted."
			: undefined;
	return { servers, errors: loaded.errors, ...(note ? { note } : {}) };
}

/** Options for {@link loginMcpServer}. */
export interface PlusMcpLoginOptions extends PlusMcpOptions {
	/**
	 * Open the authorization URL in the user's browser (required: pi-plus hosts own window/shell
	 * access; the CLI's fallback does not apply in-process).
	 */
	openUrl: (url: string) => void;
	/**
	 * Ask the user to paste the redirected URL when the loopback callback cannot reach this machine
	 * (remote hosts). Omitted: sign-in waits for the loopback callback only.
	 */
	promptForRedirectUrl?: (signal: AbortSignal) => Promise<string | undefined>;
	/** Whole-flow timeout in ms, applied when no `signal` is given. Defaults to 300000 (5 minutes), like `pi mcp login`. */
	timeoutMs?: number;
	/** Abort the flow; `McpSignInCancelledError` rejects the promise like a pi timeout. */
	signal?: AbortSignal;
}

/** Default deadline for `pi mcp login`. */
export const DEFAULT_MCP_LOGIN_TIMEOUT_MS = 300_000;

/** Used when the host does not collect a pasted redirect URL: resolves only via the callback server. */
function redirectUrlFromCallbackOnly(signal: AbortSignal): Promise<string | undefined> {
	return new Promise((_resolve, reject) => {
		const cancel = () => reject(new McpSignInCancelledError());
		if (signal.aborted) cancel();
		else signal.addEventListener("abort", cancel, { once: true });
	});
}

/**
 * Run pi's OAuth sign-in for one configured server (authorization code + loopback callback, like
 * `pi mcp login <name>`). Connects first: an already-authenticated server resolves immediately and
 * returns its tools; a `needs-auth` server opens `openUrl` and waits for the callback. Throws
 * `McpSignInCancelledError` on abort/timeout and a descriptive error for non-OAuth or unreachable
 * servers. Tokens are stored in pi's `mcp-auth.json` under the resolved agent directory.
 */
export async function loginMcpServer(name: string, options: PlusMcpLoginOptions): Promise<string[]> {
	const resolved = resolveMcpOptions(options);
	const entry = findMcpEntry(name, resolved);
	const credentials = mcpCredentialStore(resolved);
	const connection = createMcpConnection(entry, resolved, credentials);
	const serverUrl = connection.oauthUrl;
	if (!serverUrl)
		throw new Error(
			`MCP server "${name}" does not use OAuth. Only HTTP servers without an Authorization header or auth provider sign in here.`,
		);
	const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_LOGIN_TIMEOUT_MS;
	const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
	const prompt: McpSignInPrompt = {
		showAuthorizationUrl: (authorizationUrl) => options.openUrl(authorizationUrl.href),
		promptForRedirectUrl: options.promptForRedirectUrl ?? redirectUrlFromCallbackOnly,
	};
	try {
		try {
			await connection.getClient();
			// Already signed in: the stored token worked, nothing to do.
		} catch {
			if (connection.state !== "needs-auth") {
				throw new Error(`MCP server "${name}" failed to connect: ${connection.error ?? "unknown error"}`);
			}
			await signInMcpServer({
				serverUrl,
				store: credentials.forServer(name, serverUrl),
				settings: connection.oauthSettings(),
				challenge: connection.challenge,
				prompt,
				signal,
			});
			connection.challenge = undefined;
			try {
				await connection.reconnect();
			} catch (connectError) {
				const message = connectError instanceof Error ? connectError.message : String(connectError);
				throw new Error(`Signed in, but ${message}`);
			}
		}
		return connection.tools.map((tool) => tool.name);
	} finally {
		await connection.close();
	}
}

/**
 * Remove a server's stored OAuth credentials, like `pi mcp logout <name>`. Returns false when the
 * server never signed in (no credentials stored) and throws when the server does not use OAuth.
 * The config entry itself is untouched — use removeMcpServer for that.
 */
export function logoutMcpServer(name: string, options: PlusMcpOptions = {}): boolean {
	const resolved = resolveMcpOptions(options);
	const entry = findMcpEntry(name, resolved);
	const connection = createMcpConnection(entry, resolved, mcpCredentialStore(resolved));
	const serverUrl = connection.oauthUrl;
	if (!serverUrl) throw new Error(`MCP server "${name}" does not use OAuth, so it has no credentials to sign out of.`);
	return mcpCredentialStore(resolved).remove(name, serverUrl);
}

/** One stored OAuth credential record, keyed like pi's `mcp-auth.json` (namespace|url). */
export interface McpCredentialInfo {
	key: string;
	hasClientInformation: boolean;
	hasTokens: boolean;
	tokensExpireAt?: number;
}

/**
 * Summarize `<agentDir>/mcp-auth.json` without secret material, like `pi mcp credentials`.
 * Returns an empty list when the file does not exist yet.
 */
export function listMcpCredentials(options: PlusMcpOptions = {}): McpCredentialInfo[] {
	const resolved = resolveMcpOptions(options);
	const path = join(resolved.agentDir, "mcp-auth.json");
	if (!existsSync(path)) return [];
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
	const states = parsed as Record<string, { clientInformation?: unknown; tokens?: unknown; tokensExpireAt?: unknown }>;
	return Object.entries(states).map(([key, state]) => ({
		key,
		hasClientInformation: state.clientInformation !== undefined && state.clientInformation !== null,
		hasTokens: state.tokens !== undefined && state.tokens !== null,
		...(typeof state.tokensExpireAt === "number" ? { tokensExpireAt: state.tokensExpireAt } : {}),
	}));
}
