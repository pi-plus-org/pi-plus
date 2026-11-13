/**
 * Tests for the programmatic library entry (packages/plus-api/src/api.ts) — the
 * surface the "pi-plus-sdk" npm package exposes via its exports map for hosts
 * that embed pi-plus in-process (e.g. a desktop app).
 *
 * The session-construction test uses the faux provider (no real APIs) and an
 * in-memory session/settings manager with temp cwd/agentDir, so it never
 * touches ~/.pi.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
// Vitest does not apply the loader redirects, so the coding-agent barrel hands
// out the unpatched upstream class type; SessionManager.deleteSession/search
// live on the pi-plus overlay, which patches the shared class object in place
// (the same object the barrel re-exports once src/api.ts loads the overlay).
import { SessionManager } from "../../plus/src/coding-agent/core/session-manager.ts";
import type { ExtensionAPI, SessionShutdownEvent, SessionStartEvent } from "../src/api.ts";
import {
	AGENT_DIR,
	addMcpServer,
	addProfile,
	checkMcpServers,
	clearDefaultProfile,
	createAgentSession,
	createPlusAgentSession,
	createPlusAgentSessionRuntime,
	createPlusUIContext,
	createTerminalAuthInteraction,
	DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
	DEFAULT_CONTEXT_FLOOR_TOKENS,
	DEFAULT_MCP_LOGIN_TIMEOUT_MS,
	DefaultResourceLoader,
	findProfile,
	getAutoCompactThresholdPercent,
	getContextFloorTokens,
	getContextWindowCapTokens,
	getDefaultProfileName,
	getMcpConfigPaths,
	installPackage,
	listMcpCredentials,
	listMcpServers,
	listPackages,
	loadProfiles,
	loginMcpServer,
	loginProvider,
	logoutMcpServer,
	ModelRuntime,
	materializeProfile,
	plusSdkExtensionFactories,
	profileDirFor,
	readPiPlusSettings,
	removeMcpServer,
	removePackage,
	removeProfile,
	removeProfileDir,
	renameProfile,
	SettingsManager,
	setAutoCompactThresholdPercent,
	setContextFloorTokens,
	setContextWindowCapTokens,
	setDefaultProfile,
	subscribeToRecapFailures,
	syncProfilePackagesToSource,
	THINKING_LEVELS,
	updateMcpServer,
	updatePackages,
	updateProfile,
	validateMcpServer,
} from "../src/api.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-plus-api-test-"));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface FauxHarness {
	faux: ReturnType<typeof registerFauxProvider>;
	model: ReturnType<ReturnType<typeof registerFauxProvider>["getModel"]>;
	modelRuntime: ModelRuntime;
}

/** Faux provider + offline ModelRuntime with an in-memory api key, so session
 *  and runtime tests never touch ~/.pi or the network. Callers set responses
 *  and must unregister in a finally block. */
async function createFauxHarness(): Promise<FauxHarness> {
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(tempDirs[0] ?? tmpdir(), "faux-models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	return { faux, model, modelRuntime };
}

/** Wait until the faux provider has served `count` calls. The pi-plus
 *  session-recap extension fires a fire-and-forget title call off the first
 *  agent_settled, sharing this scripted queue — without draining it here the
 *  recap would steal the response scripted for the next prompt. */
async function waitForFauxCalls(faux: FauxHarness["faux"], count: number, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (faux.state.callCount < count) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} faux calls`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("api entry exports", () => {
	it("exposes the pi-plus additions and the upstream SDK surface", () => {
		expect(typeof createPlusAgentSession).toBe("function");
		expect(typeof createPlusUIContext).toBe("function");
		expect(Array.isArray(plusSdkExtensionFactories)).toBe(true);
		expect(typeof subscribeToRecapFailures).toBe("function");
		// Upstream re-exports used by SDK hosts.
		expect(typeof createAgentSession).toBe("function");
		expect(typeof SessionManager.inMemory).toBe("function");
		expect(typeof DefaultResourceLoader).toBe("function");
	});

	it("registers exactly the twelve non-TUI pi-plus extensions, all hidden", () => {
		// InlineExtension is a union (function form or object form); this entry
		// uses the object form, so narrow before reading name/hidden.
		const factories = plusSdkExtensionFactories.map((extension) => {
			if (typeof extension === "function") throw new Error("expected object-form extension factories");
			return { name: extension.name, hidden: extension.hidden };
		});
		expect(factories.map((extension) => extension.name)).toEqual([
			"pi-plus-subagent",
			"pi-plus-tasks",
			"pi-plus-memory",
			"pi-plus-plan",
			"pi-plus-session-recap",
			"pi-plus-ask-user",
			"pi-plus-hooks",
			"pi-plus-context-guard",
			"pi-plus-diagram",
			"pi-plus-cd",
			"pi-plus-init",
			"pi-plus-web-search",
		]);
		for (const extension of factories) {
			expect(extension.hidden).toBe(true);
		}
	});
});

describe("profile management surface", () => {
	it("re-exports the curated pi-hub profile API", () => {
		// Shape-only: hub's own suite covers behavior; calling loadProfiles()
		// here would read the real ~/.pi (config paths are frozen at import).
		for (const fn of [
			addProfile,
			clearDefaultProfile,
			findProfile,
			getDefaultProfileName,
			loadProfiles,
			materializeProfile,
			profileDirFor,
			removeProfile,
			removeProfileDir,
			renameProfile,
			setDefaultProfile,
			syncProfilePackagesToSource,
			updateProfile,
		]) {
			expect(typeof fn).toBe("function");
		}
		expect(typeof AGENT_DIR).toBe("string");
		expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});
});

describe("package maintenance surface", () => {
	it("re-exports the package maintenance entries", () => {
		for (const fn of [listPackages, installPackage, removePackage, updatePackages]) {
			expect(typeof fn).toBe("function");
		}
	});

	it("installs a local package into user settings, lists it by scope, and removes it", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		const pkgDir = makeTempDir();
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "test-pi-pkg" }));
		// A local install only resolves the path (no copy/npm), so this test
		// stays offline; the relative source is stored against the settings dir.
		await installPackage(pkgDir, { cwd, agentDir });

		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(settings.packages).toHaveLength(1);

		const listed = listPackages({ cwd, agentDir });
		expect(listed).toEqual([
			{
				source: settings.packages[0],
				scope: "user",
				filtered: false,
				installedPath: pkgDir,
			},
		]);

		await expect(removePackage(pkgDir, { cwd, agentDir })).resolves.toBe(true);
		expect(listPackages({ cwd, agentDir })).toEqual([]);
		// Nothing left to match: false, not a throw.
		await expect(removePackage(pkgDir, { cwd, agentDir })).resolves.toBe(false);
	});

	it("honors project trust for project-scope declarations", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		const pkgDir = makeTempDir();
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "test-pi-pkg" }));

		// Untrusted: project-scope writes are refused before any install runs.
		await expect(installPackage(pkgDir, { cwd, agentDir, local: true, projectTrusted: false })).rejects.toThrow(
			/Project is not trusted/,
		);

		// Trusted: the declaration lands in <cwd>/.pi/settings.json.
		await installPackage(pkgDir, { cwd, agentDir, local: true, projectTrusted: true });
		const projectSettings = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"));
		expect(projectSettings.packages).toHaveLength(1);
		expect(listPackages({ cwd, agentDir }).map((pkg) => pkg.scope)).toEqual(["project"]);

		// An untrusted manager also stops reading project declarations.
		expect(listPackages({ cwd, agentDir, projectTrusted: false })).toEqual([]);
	});
});

describe("MCP management surface", () => {
	it("re-exports the MCP maintenance entries", () => {
		for (const fn of [
			getMcpConfigPaths,
			listMcpServers,
			validateMcpServer,
			addMcpServer,
			removeMcpServer,
			updateMcpServer,
			checkMcpServers,
			loginMcpServer,
			logoutMcpServer,
			listMcpCredentials,
		]) {
			expect(typeof fn).toBe("function");
		}
		expect(DEFAULT_MCP_LOGIN_TIMEOUT_MS).toBe(300_000);
	});

	it("adds, disables, and removes a global server without ever connecting", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		expect(getMcpConfigPaths({ cwd, agentDir })).toEqual({
			global: join(agentDir, "mcp.json"),
			project: join(cwd, ".pi", "mcp.json"),
		});

		const add = addMcpServer("demo", { command: "node", args: ["server.js"] }, { cwd, agentDir });
		expect(add).toEqual({ replaced: false, path: join(agentDir, "mcp.json") });
		expect(JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")).mcpServers.demo).toEqual({
			command: "node",
			args: ["server.js"],
		});
		expect(addMcpServer("demo", { command: "node", args: ["other.js"] }, { cwd, agentDir }).replaced).toBe(true);

		const listed = listMcpServers({ cwd, agentDir });
		expect(listed.servers).toHaveLength(1);
		expect(listed.servers[0]).toMatchObject({ name: "demo", scope: "global" });

		expect(updateMcpServer("demo", { enabled: false }, { cwd, agentDir })).toEqual({
			path: join(agentDir, "mcp.json"),
		});
		const check = await checkMcpServers({ cwd, agentDir });
		expect(check.errors).toEqual([]);
		expect(check.servers).toEqual([
			expect.objectContaining({ name: "demo", scope: "global", enabled: false, state: "disabled", tools: [] }),
		]);

		expect(removeMcpServer("demo", { cwd, agentDir })).toEqual({ removed: true, path: join(agentDir, "mcp.json") });
		expect(removeMcpServer("demo", { cwd, agentDir }).removed).toBe(false);
		expect(listMcpServers({ cwd, agentDir }).servers).toEqual([]);
	});

	it("validates entries the way the loader does, without writing them", () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		expect(validateMcpServer("ok", { command: "node" })).toMatchObject({ command: "node" });
		expect(validateMcpServer("ok", { url: "not-a-url" })).toContain("must be an http or https URL");
		expect(validateMcpServer("bad name", { command: "node" })).toContain("invalid server name");
		expect(() => addMcpServer("bad name", { command: "node" }, { cwd, agentDir })).toThrow(/invalid server name/);
		expect(existsSync(join(agentDir, "mcp.json"))).toBe(false);
	});

	it("honors project trust and scopes for project writes and overrides", () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		addMcpServer("global-demo", { command: "node" }, { cwd, agentDir });

		expect(() =>
			addMcpServer("proj", { command: "node" }, { cwd, agentDir, local: true, projectTrusted: false }),
		).toThrow(/Project is not trusted/);
		expect(() =>
			updateMcpServer(
				"global-demo",
				{ exposure: "direct" },
				{ cwd, agentDir, scope: "project", projectTrusted: false },
			),
		).toThrow(/Project is not trusted/);

		addMcpServer("proj", { command: "node" }, { cwd, agentDir, local: true });
		expect(Object.keys(JSON.parse(readFileSync(join(cwd, ".pi", "mcp.json"), "utf8")).mcpServers)).toEqual(["proj"]);
		expect(
			listMcpServers({ cwd, agentDir })
				.servers.map((server) => server.scope)
				.sort(),
		).toEqual(["global", "project"]);

		// Auto-scope update writes the file that defines the entry; scope "project" creates an override.
		updateMcpServer("global-demo", { enabled: false }, { cwd, agentDir });
		expect(JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")).mcpServers["global-demo"]).toEqual({
			command: "node",
			enabled: false,
		});
		expect(updateMcpServer("global-demo", { exposure: "direct" }, { cwd, agentDir, scope: "project" })).toEqual({
			path: join(cwd, ".pi", "mcp.json"),
		});
		expect(JSON.parse(readFileSync(join(cwd, ".pi", "mcp.json"), "utf8")).mcpServers["global-demo"]).toEqual({
			exposure: "direct",
		});
		const overridden = listMcpServers({ cwd, agentDir }).servers.find((server) => server.name === "global-demo");
		expect(overridden?.override).toBe(join(cwd, ".pi", "mcp.json"));
		expect(overridden?.config).toMatchObject({ exposure: "direct", enabled: false });

		expect(() => updateMcpServer("missing", { enabled: false }, { cwd, agentDir })).toThrow(
			/No MCP server named "missing"/,
		);
	});

	it("reports broken configs and disabled servers in checkMcpServers", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { bad: {}, off: { command: "node", enabled: false } } }),
		);
		const check = await checkMcpServers({ cwd, agentDir });
		expect(check.errors).toHaveLength(1);
		expect(check.errors[0]).toContain("bad");
		expect(check.servers).toEqual([expect.objectContaining({ name: "off", state: "disabled", tools: [] })]);
	});

	it("guards login for unknown and non-OAuth servers", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		await expect(loginMcpServer("missing", { cwd, agentDir, openUrl: () => {} })).rejects.toThrow(
			/No MCP server named "missing"/,
		);
		addMcpServer("stdio-demo", { command: "node" }, { cwd, agentDir });
		await expect(loginMcpServer("stdio-demo", { cwd, agentDir, openUrl: () => {} })).rejects.toThrow(
			/does not use OAuth/,
		);
	});

	it("lists and removes OAuth credentials without exposing secrets", () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		expect(listMcpCredentials({ cwd, agentDir })).toEqual([]);
		writeFileSync(
			join(agentDir, "mcp-auth.json"),
			JSON.stringify({
				"mcp__demo|http://127.0.0.1:9/mcp": {
					clientInformation: { client_id: "cid" },
					tokens: { access_token: "secret" },
					tokensExpireAt: 123,
				},
			}),
		);
		expect(listMcpCredentials({ cwd, agentDir })).toEqual([
			{ key: "mcp__demo|http://127.0.0.1:9/mcp", hasClientInformation: true, hasTokens: true, tokensExpireAt: 123 },
		]);
		expect(() => logoutMcpServer("missing", { cwd, agentDir })).toThrow(/No MCP server named "missing"/);
		addMcpServer("demo", { url: "http://127.0.0.1:9/mcp" }, { cwd, agentDir });
		addMcpServer(
			"keyed",
			{ url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer secret" } },
			{ cwd, agentDir },
		);
		expect(() => logoutMcpServer("keyed", { cwd, agentDir })).toThrow(/does not use OAuth/);
		expect(logoutMcpServer("demo", { cwd, agentDir })).toBe(true);
		expect(listMcpCredentials({ cwd, agentDir })).toEqual([]);
	});
});

describe("provider login surface", () => {
	it("re-exports loginProvider and the terminal interaction", () => {
		expect(typeof loginProvider).toBe("function");
		const interaction = createTerminalAuthInteraction();
		expect(typeof interaction.prompt).toBe("function");
		expect(typeof interaction.notify).toBe("function");
	});

	it("rejects an unknown provider before running any login", async () => {
		// agentDir points at a temp dir so the runtime's auth store never
		// touches ~/.pi; the provider lookup throws before any interaction.
		const agentDir = makeTempDir();
		await expect(loginProvider("no-such-provider-xyz", { agentDir })).rejects.toThrow(/Unknown provider/);
	});
});

describe("session history management", () => {
	it("deleteSession removes a transcript, tolerates missing files, refuses non-jsonl", () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-sdk-sessions-"));
		try {
			const file = join(dir, "session.jsonl");
			writeFileSync(file, "{}\n");
			expect(SessionManager.deleteSession(file)).toBe(true);
			expect(existsSync(file)).toBe(false);
			// Missing file: false, not a throw.
			expect(SessionManager.deleteSession(file)).toBe(false);
			// Guard: arbitrary files must not be deletable through this API.
			const other = join(dir, "notes.txt");
			writeFileSync(other, "keep me\n");
			expect(() => SessionManager.deleteSession(other)).toThrow(/non-session file/i);
			expect(existsSync(other)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("search matches session name, first message, and any message text", async () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-sdk-search-"));
		const header = (id: string, cwd: string) =>
			JSON.stringify({ type: "session", id, version: 3, timestamp: new Date(0).toISOString(), cwd });
		const msg = (id: string, parentId: string, role: string, text: string) =>
			JSON.stringify({
				type: "message",
				id,
				parentId,
				message: { role, content: [{ type: "text", text }], timestamp: 0 },
			});
		try {
			writeFileSync(
				join(dir, "a.jsonl"),
				`${[
					header("id-aaa", "/tmp/a"),
					msg("a1", "h", "user", "quantum flux analysis"),
					msg("a2", "a1", "assistant", "the FLUX capacitor hums"),
				].join("\n")}\n`,
			);
			writeFileSync(
				join(dir, "b.jsonl"),
				`${[
					header("id-bbb", "/tmp/b"),
					JSON.stringify({ type: "session_info", id: "b0", parentId: "h", name: "Zephyr rename target" }),
					msg("b1", "b0", "user", "unrelated"),
				].join("\n")}\n`,
			);
			writeFileSync(
				join(dir, "c.jsonl"),
				`${[header("id-ccc", "/tmp/c"), msg("c1", "h", "user", "plain nothing")].join("\n")}\n`,
			);

			// Body text hit (case-insensitive, not the first message).
			expect((await SessionManager.search("flux capacitor", dir)).map((s) => s.id)).toEqual(["id-aaa"]);
			// session_info name hit.
			expect((await SessionManager.search("zephyr", dir)).map((s) => s.id)).toEqual(["id-bbb"]);
			// First-message hit.
			expect((await SessionManager.search("plain", dir)).map((s) => s.id)).toEqual(["id-ccc"]);
			expect(await SessionManager.search("   ", dir)).toEqual([]);
			expect(await SessionManager.search("no-such-text", dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("pi-plus context settings", () => {
	it("threshold/floor/cap round-trip through the piPlus block of settings.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-sdk-settings-"));
		const file = join(dir, "settings.json");
		const previous = process.env.PI_CODING_AGENT_DIR;
		const previousBase = process.env.PI_PLUS_BASE_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.PI_PLUS_BASE_AGENT_DIR;
		try {
			// Defaults with no file present.
			expect(getAutoCompactThresholdPercent()).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT);
			expect(getContextFloorTokens()).toBe(DEFAULT_CONTEXT_FLOOR_TOKENS);
			expect(getContextWindowCapTokens()).toBeUndefined();
			// Persist and read back.
			setAutoCompactThresholdPercent(95);
			setContextFloorTokens(32768);
			setContextWindowCapTokens(262144);
			expect(readPiPlusSettings()).toEqual({
				autoCompactThresholdPercent: 95,
				contextFloorTokens: 32768,
				contextWindowCapTokens: 262144,
			});
			// The block lives in the agent settings.json alongside upstream keys.
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
				piPlus: {
					autoCompactThresholdPercent: 95,
					contextFloorTokens: 32768,
					contextWindowCapTokens: 262144,
				},
			});
			// Reset removes the key (undefined = default / no cap).
			setAutoCompactThresholdPercent(undefined);
			setContextFloorTokens(undefined);
			setContextWindowCapTokens(undefined);
			expect(readPiPlusSettings()).toEqual({});
			expect(getAutoCompactThresholdPercent()).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			if (previousBase === undefined) delete process.env.PI_PLUS_BASE_AGENT_DIR;
			else process.env.PI_PLUS_BASE_AGENT_DIR = previousBase;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("createPlusUIContext", () => {
	it("delegates dialogs to host handlers in ask-user fallback argument order", async () => {
		const calls: unknown[] = [];
		const ui = createPlusUIContext({
			select: async (title, options) => {
				calls.push(["select", title, options]);
				return options[1];
			},
			confirm: async (title, message) => {
				calls.push(["confirm", title, message]);
				return true;
			},
			input: async (title, placeholder) => {
				calls.push(["input", title, placeholder]);
				return "typed";
			},
			editor: async (title, prefill) => {
				calls.push(["editor", title, prefill]);
				return "edited";
			},
			notify: (message, type) => {
				calls.push(["notify", message, type]);
			},
		});
		expect(await ui.select("Header: Question?", ["a", "Other"])).toBe("Other");
		expect(await ui.confirm("Header", 'Include "x"?')).toBe(true);
		expect(await ui.input("Header", "Your answer")).toBe("typed");
		expect(await ui.editor("Title", "pre")).toBe("edited");
		ui.notify("heads up", "warning");
		expect(calls).toEqual([
			["select", "Header: Question?", ["a", "Other"]],
			["confirm", "Header", 'Include "x"?'],
			["input", "Header", "Your answer"],
			["editor", "Title", "pre"],
			["notify", "heads up", "warning"],
		]);
	});

	it("tolerates a missing editor/notify and no-ops terminal-only members", async () => {
		const ui = createPlusUIContext({
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
		});
		expect(await ui.editor("Title")).toBeUndefined();
		expect(ui.getEditorText()).toBe("");
		expect(ui.getToolsExpanded()).toBe(false);
		expect(ui.getAllThemes()).toEqual([]);
		expect(() => ui.setTitle("x")).not.toThrow();
		// The `theme` getter is live (initTheme ran during creation).
		expect(typeof ui.theme.fg).toBe("function");
	});
});

describe("createPlusAgentSession", () => {
	it("loads the pi-plus extensions, emits session_start once, and answers a prompt", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		const { faux, model, modelRuntime } = await createFauxHarness();
		faux.setResponses([fauxAssistantMessage("Hello from the faux provider.")]);

		const sessionStarts: string[] = [];
		const { session, extensionsResult } = await createPlusAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			// Observer proves host factories are appended after the pi-plus ones
			// and that bindExtensions emits session_start exactly once.
			extensionFactories: [
				{
					name: "test-observer",
					factory: (pi: ExtensionAPI) => {
						pi.on("session_start", (event: SessionStartEvent) => {
							sessionStarts.push(event.reason);
						});
					},
				},
			],
		});
		try {
			const toolNames = new Set(
				extensionsResult.extensions.flatMap((extension) => Array.from(extension.tools.keys())),
			);
			for (const expected of [
				"ask_user",
				"TaskCreate",
				"TaskUpdate",
				"TaskList",
				"TaskGet",
				"EnterPlanMode",
				"ExitPlanMode",
				"memory_save",
				"memory_recall",
				"subagent",
			]) {
				expect(toolNames.has(expected)).toBe(true);
			}

			await session.prompt("Say hello");
			expect(session.getLastAssistantText()).toBe("Hello from the faux provider.");
			expect(sessionStarts).toEqual(["startup"]);
		} finally {
			session.dispose();
			faux.unregister();
		}
	}, 30000);
});

describe("createPlusAgentSessionRuntime", () => {
	// Observer extension shared by the tests: records every session_start /
	// session_shutdown the runtime drives, proving one bind per session.
	function makeRuntimeObserver() {
		const sessionStarts: string[] = [];
		const shutdowns: string[] = [];
		let rebinds = 0;
		return {
			sessionStarts,
			shutdowns,
			get rebinds() {
				return rebinds;
			},
			onRebind: () => {
				rebinds += 1;
			},
			factory: {
				name: "test-runtime-observer",
				factory: (pi: ExtensionAPI) => {
					pi.on("session_start", (event: SessionStartEvent) => {
						sessionStarts.push(event.reason);
					});
					pi.on("session_shutdown", (event: SessionShutdownEvent) => {
						shutdowns.push(event.reason);
					});
				},
			},
		};
	}

	it("binds once per session: startup, clone (fork at leaf), and switchSession all rebind", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		const sessionDir = makeTempDir();
		const { faux, model, modelRuntime } = await createFauxHarness();
		// Slot 2 is consumed by the recap extension's first-prompt title call.
		faux.setResponses([
			fauxAssistantMessage("First reply."),
			fauxAssistantMessage("Recapped title."),
			fauxAssistantMessage("Cloned continuation."),
		]);
		const observer = makeRuntimeObserver();

		const runtime = await createPlusAgentSessionRuntime({
			cwd,
			agentDir,
			model,
			modelRuntime,
			sessionManager: SessionManager.create(cwd, sessionDir),
			settingsManager: SettingsManager.inMemory(),
			extensionFactories: [observer.factory],
			onRebind: observer.onRebind,
		});

		try {
			expect(observer.sessionStarts).toEqual(["startup"]);
			expect(observer.rebinds).toBe(1);

			const session = runtime.session;
			await session.prompt("Say hello");
			expect(session.getLastAssistantText()).toBe("First reply.");
			const originalFile = session.sessionFile;
			expect(originalFile && existsSync(originalFile)).toBe(true);
			const messageCountBefore = session.messages.length;

			// Let the recap's title call reach the faux provider before forking
			// so the scripted queue order (title, then continuation) holds; the
			// title write itself may race the clone and be discarded (stale ctx).
			await waitForFauxCalls(faux, 2);

			// clone = fork at the leaf, in place: new file, same history, one rebind
			const leafId = session.sessionManager.getLeafId();
			expect(leafId).toBeTruthy();
			const clone = await runtime.fork(leafId!, { position: "at" });
			expect(clone.cancelled).toBe(false);
			expect(observer.sessionStarts).toEqual(["startup", "fork"]);
			expect(observer.rebinds).toBe(2);
			const cloned = runtime.session;
			expect(cloned).not.toBe(session);
			expect(cloned.sessionFile).not.toBe(originalFile);
			expect(cloned.messages.length).toBe(messageCountBefore);
			expect(cloned.sessionManager.getSessionDir()).toBe(sessionDir);

			await cloned.prompt("Continue");
			expect(cloned.getLastAssistantText()).toBe("Cloned continuation.");

			// switchSession resumes the original file (clone kept it on disk)
			const back = await runtime.switchSession(originalFile!);
			expect(back.cancelled).toBe(false);
			expect(observer.sessionStarts).toEqual(["startup", "fork", "resume"]);
			expect(observer.rebinds).toBe(3);
			expect(runtime.session.getLastAssistantText()).toBe("First reply.");
			expect(runtime.cwd).toBe(cwd);
		} finally {
			await runtime.dispose();
			expect(observer.shutdowns.length).toBeGreaterThan(0);
			faux.unregister();
		}
	}, 30000);

	it("fork before the session file is first written throws the CLI's not-saved guard", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		const sessionDir = makeTempDir();
		const { faux, model, modelRuntime } = await createFauxHarness();
		const observer = makeRuntimeObserver();

		const runtime = await createPlusAgentSessionRuntime({
			cwd,
			agentDir,
			model,
			modelRuntime,
			sessionManager: SessionManager.create(cwd, sessionDir),
			settingsManager: SettingsManager.inMemory(),
			extensionFactories: [observer.factory],
			onRebind: observer.onRebind,
		});

		try {
			// A setup entry exists (so the leaf is valid) but the file has not
			// been flushed yet — SessionManager writes only once the session
			// holds a user or assistant message (upstream #10000 flush rule).
			runtime.session.sessionManager.appendThinkingLevelChange("off");
			const leafId = runtime.session.sessionManager.getLeafId();
			expect(leafId).toBeTruthy();
			expect(runtime.session.sessionFile && existsSync(runtime.session.sessionFile)).toBe(false);
			await expect(runtime.fork(leafId!, { position: "at" })).rejects.toThrow(/has not been saved yet/);
		} finally {
			await runtime.dispose();
			faux.unregister();
		}
	}, 30000);

	it("routes /cd through the runtime actions wired for embedding hosts", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		const targetDir = makeTempDir();
		const { faux, model, modelRuntime } = await createFauxHarness();
		const observer = makeRuntimeObserver();

		// /cd relocates into getDefaultSessionDir(target) — with no agentDir
		// argument it resolves through PI_CODING_AGENT_DIR, so point that at
		// the temp agent dir to keep the test out of the real ~/.pi.
		const previousEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const runtime = await createPlusAgentSessionRuntime({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			extensionFactories: [observer.factory],
			onRebind: observer.onRebind,
		});

		try {
			// createPlusAgentSession cannot run /cd at all (no switchSession
			// action); the runtime default actions must make it work.
			await runtime.session.prompt(`/cd ${targetDir}`);
			expect(runtime.cwd).toBe(targetDir);
			expect(observer.sessionStarts).toEqual(["startup", "resume"]);
			expect(observer.rebinds).toBe(2);
			// The relocated session lives under the target cwd's default dir
			// (getDefaultSessionDir(target) resolves through the env agent dir).
			const targetSlug = `--${targetDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const sessionFile = runtime.session.sessionFile;
			expect(sessionFile?.startsWith(join(agentDir, "sessions", targetSlug))).toBe(true);
		} finally {
			await runtime.dispose();
			faux.unregister();
			if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousEnv;
		}
	}, 30000);
});

describe("api.d.ts drift guard", () => {
	it("declares every runtime export of src/api.ts", () => {
		const plusDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		const runtimeSource = readFileSync(join(plusDir, "src", "api.ts"), "utf8");
		const declarationSource = readFileSync(join(plusDir, "api.d.ts"), "utf8");
		// `export * from` barrel re-exports are covered by api.d.ts's own
		// `export * from "@earendil-works/pi-coding-agent"`; named exports must
		// each appear in the declaration file.
		const namedExports = new Set<string>();
		const collect = (source: string) => {
			for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const|interface)\s+([A-Za-z0-9_]+)/g)) {
				namedExports.add(match[1]);
			}
		};
		collect(runtimeSource);
		for (const match of runtimeSource.matchAll(/export\s+\*\s+from\s+"\.\/([A-Za-z0-9_.-]+)"/g)) {
			// `export *` local modules contribute their own declarations to the entry; scan them too.
			collect(readFileSync(join(plusDir, "src", match[1]), "utf8"));
		}
		assert.ok(namedExports.size >= 4, `expected named exports in api.ts, got: ${[...namedExports].join(", ")}`);
		for (const name of namedExports) {
			assert.ok(declarationSource.includes(name), `api.d.ts is missing a declaration for api.ts export "${name}"`);
		}
	});
});
