/**
 * Programmatic library entry for pi-plus-sdk ("pi-plus-sdk" npm package, `api.js`).
 *
 * Lets a host application (e.g. a desktop app) embed pi with the pi-plus layer
 * in-process, without going through the `pipi` CLI:
 * - the compaction/context/reasoning overrides are baked in at bundle time by
 *   the same redirect plugin that produces the CLI, because this module imports
 *   upstream runtime values ONLY through the coding-agent index barrel (direct
 *   relative imports of redirected upstream modules would bypass the wrappers)
 * - the twelve non-TUI pi-plus extensions (subagent, tasks, memory, plan,
 *   ask-user, hooks, context-guard, diagram, web-search, recap, /cd, /init)
 *   are registered here the same
 *   way the
 *   CLI wrapper registers them; the CLI-only ones (banner, vim, tab-title,
 *   plain-tools) live in the pi-plus artifact and are excluded from this
 *   bundle by construction
 * - hosts that want working ask_user dialogs provide dialog handlers via the
 *   `ui` option; the session is bound with mode "rpc" so ask-user falls back
 *   to sequential select/input/confirm dialogs, and with mode "print"
 *   otherwise (matching upstream's non-interactive modes)
 * - createPlusAgentSessionRuntime additionally returns an AgentSessionRuntime,
 *   giving hosts the CLI's session-replacement machinery (/cd, /new, /fork,
 *   /clone, resume-switch) with the same layering and rebind rules
 * - profile management (pi-hub profiles.json CRUD + agent-dir
 *   materialization) is re-exported from ./profiles.ts so hosts do not
 *   reimplement the pi-hub file contract
 * - provider login (OAuth login page / API-key setup, pi's /login equivalent,
 *   which pi-plus disables in the TUI) is re-exported from ./auth.ts
 * - the task store (TaskCreate/TaskUpdate/TaskList/Get backing files under
 *   <agentDir>/tasks/<sessionId>/) plus subscribeToTasks are re-exported from
 *   the tasks store module, so hosts can render a native task panel that stays
 *   in sync without polling the files
 * - session recap failures (the auto-title call timing out or erroring after
 *   the first prompt / a compaction) are published to subscribeToRecapFailures,
 *   re-exported from the recap events module, so hosts can show their own
 *   recap status; hosts that wire PlusUIDialogHandlers.notify also receive the
 *   transcript warning through the notify bridge
 * - pi package maintenance (install/remove/list/update --extensions, the
 *   programmatic form of `pi install`/`remove`/`list`/`update --extensions`)
 *   is re-exported from ./packages.ts, wrapping coding-agent's
 *   DefaultPackageManager with explicit cwd/agentDir and a project-trust guard
 * - the pi-plus context settings (auto-compact threshold percent, context floor,
 *   context window cap — the piPlus block of the base agent settings.json, plus
 *   the generic readPiPlusSettings/updatePiPlusSettings for host-owned keys) are
 *   re-exported from packages/plus's plus-settings module
 *
 * Hosts without a pi CLI on PATH should pass excludeTools: ["subagent"]:
 * the subagent tool launches a pi subprocess and, in a CLI-less host such as
 * an Electron app, its invocation candidates can relaunch the host itself.
 */

// Types SDK hosts need that the upstream barrel does not export (the barrel is
// kept pristine). Type-only deep imports from non-redirected modules, so no
// patch is bypassed or double-loaded.
export type { ConfiguredPackage, PackageUpdate } from "../../coding-agent/src/core/package-manager.ts";
export type { DefaultResourceLoaderOptions } from "../../coding-agent/src/core/resource-loader.ts";
export * from "../../coding-agent/src/index.ts";
// The session-marker helpers and the session-dir helper: hosts declare their
// mode before creating sessions (see the pi-plus session overlay). The upstream
// barrel does not export getDefaultSessionDir and the Override Policy keeps it
// that way, so it is surfaced here through the overlay, which re-exports it.
export {
	getDefaultSessionDir,
	getDefaultSessionInteractive,
	setDefaultSessionInteractive,
} from "../../plus/src/coding-agent/core/session-manager.ts";
export * from "../../plus/src/context/plus-settings.ts";
export * from "../../plus/src/extensions/cache.ts";
export {
	type RenderDiagramHtmlOptions,
	renderDiagramHtml,
	renderDiagramSvg,
} from "../../plus/src/extensions/diagram/html.ts";
export {
	type DiagramLayout,
	layoutDiagram,
	type PlacedEdge,
	type PlacedNode,
} from "../../plus/src/extensions/diagram/layout.ts";
export type {
	DiagramDetails,
	DiagramEdge,
	DiagramNode,
	DiagramShape,
	DiagramSpec,
} from "../../plus/src/extensions/diagram/types.ts";
export * from "../../plus/src/extensions/permissions/index.ts";
export * from "./mcp.ts";
export * from "./packages.ts";

import type { PlanReviewDialogChoice } from "../../plus/src/extensions/plan/index.ts";
export type { PlanReviewDialogChoice, PlanReviewDialogUI };
export {
	type RecapFailure,
	type RecapFailureReason,
	subscribeToRecapFailures,
} from "../../plus/src/extensions/recap/events.ts";
export {
	subscribeToTasks,
	type Task,
	type TaskListListener,
	type TaskStatus,
	TaskStore,
} from "../../plus/src/extensions/tasks/store.ts";
export * from "./auth.ts";
export * from "./profiles.ts";

import type { DefaultResourceLoaderOptions } from "../../coding-agent/src/core/resource-loader.ts";
import type {
	AgentSession,
	AgentSessionRuntime,
	AgentSessionRuntimeDiagnostic,
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	CreateAgentSessionRuntimeFactory,
	ExtensionAPI,
	ExtensionCommandContextActions,
	ExtensionError,
	ExtensionUIContext,
	InlineExtension,
} from "../../coding-agent/src/index.ts";
import {
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	DefaultResourceLoader,
	getAgentDir,
	initTheme,
	SessionManager,
	SettingsManager,
} from "../../coding-agent/src/index.ts";
import { theme } from "../../coding-agent/src/modes/interactive/theme/theme.ts";
import {
	getDefaultSessionDir,
	setDefaultSessionInteractive,
} from "../../plus/src/coding-agent/core/session-manager.ts";
import {
	type PlanReviewDialogUI,
	registerAskUser,
	registerCd,
	registerContextGuard,
	registerDiagram,
	registerInit,
	registerMemory,
	registerPlan,
	registerRecap,
	registerSubagent,
	registerTasks,
	registerUserHooks,
	registerWebSearch,
} from "../../plus/src/extensions/index.ts";

/**
 * Hidden pi-plus extension factories for non-TUI (SDK) hosts: the same
 * registrations the `pipi` CLI wrapper makes, minus the TUI-only ones.
 * Passed to DefaultResourceLoader alongside any host-provided factories.
 *
 * `agentDir` binds the session's agent dir into the sub-agent-spawning
 * extensions (subagent, memory extraction) so their child `pipi` processes
 * carry `--as <profile>`: SDK hosts never set PI_CODING_AGENT_DIR per
 * session, and a child without the pin re-resolves the stored default
 * profile — which would run the session's model against that profile's
 * baseUrl/auth (wrong endpoint). Unset falls back to the env, exactly like
 * the CLI wrapper.
 */
export function createPlusSdkExtensionFactories(agentDir?: string): InlineExtension[] {
	return [
		{ name: "pi-plus-subagent", factory: (pi: ExtensionAPI) => registerSubagent(pi, { agentDir }), hidden: true },
		{ name: "pi-plus-tasks", factory: registerTasks, hidden: true },
		{ name: "pi-plus-memory", factory: (pi: ExtensionAPI) => registerMemory(pi, { agentDir }), hidden: true },
		{ name: "pi-plus-plan", factory: registerPlan, hidden: true },
		{ name: "pi-plus-session-recap", factory: registerRecap, hidden: true },
		{ name: "pi-plus-ask-user", factory: registerAskUser, hidden: true },
		{ name: "pi-plus-hooks", factory: registerUserHooks, hidden: true },
		{ name: "pi-plus-context-guard", factory: registerContextGuard, hidden: true },
		{ name: "pi-plus-diagram", factory: registerDiagram, hidden: true },
		{ name: "pi-plus-cd", factory: registerCd, hidden: true },
		{ name: "pi-plus-init", factory: registerInit, hidden: true },
		{ name: "pi-plus-web-search", factory: registerWebSearch, hidden: true },
	];
}

/** Env-fallback binding for hosts importing the array directly. */
export const plusSdkExtensionFactories: InlineExtension[] = createPlusSdkExtensionFactories();

/**
 * Dialog callbacks a host implements to give extensions a minimal UI. select /
 * confirm / input are enough for the ask_user tool's non-TUI fallback; editor
 * and notify are optional conveniences (notify defaults to a no-op).
 */
export interface PlusUIDialogHandlers {
	/** Show a selector and return the chosen option label, or undefined when cancelled. */
	select(title: string, options: string[]): Promise<string | undefined>;
	/** Show a confirmation dialog; false when declined or cancelled. */
	confirm(title: string, message: string): Promise<boolean>;
	/** Show a text input dialog, or undefined when cancelled. */
	input(title: string, placeholder?: string): Promise<string | undefined>;
	/** Show a multi-line editor, or undefined when cancelled. */
	editor?(title: string, prefill?: string): Promise<string | undefined>;
	/**
	 * Dedicated plan-review dialog (ExitPlanMode). The host renders the plan
	 * markdown and offers Claude Code style choices; "approveAcceptEdits" /
	 * "approveAuto" / "approveBypass" approve the plan AND set the post-approval permission
	 * mode. Return undefined when dismissed (stays in plan mode). Omit to fall
	 * back to the plain-text select.
	 */
	planReview?(plan: string): Promise<PlanReviewDialogChoice | undefined>;
	/** Show a notification (defaults to ignored). */
	notify?(message: string, type?: "info" | "warning" | "error"): void;
}

let themeInitialized = false;

/**
 * Build an ExtensionUIContext that bridges the supported dialogs to host
 * handlers and no-ops everything that needs a real terminal. The member set
 * mirrors the upstream no-op context (runner.ts noOpUIContext); initTheme()
 * is required because the exported `theme` proxy throws before it runs.
 */
export function createPlusUIContext(handlers: PlusUIDialogHandlers): ExtensionUIContext {
	if (!themeInitialized) {
		initTheme();
		themeInitialized = true;
	}
	const ui: ExtensionUIContext & Partial<PlanReviewDialogUI> = {
		select: (title, options) => handlers.select(title, options),
		confirm: (title, message) => handlers.confirm(title, message),
		input: (title, placeholder) => handlers.input(title, placeholder),
		editor: async (title, prefill) => (handlers.editor ? handlers.editor(title, prefill) : undefined),
		notify: (message, type) => handlers.notify?.(message, type),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching not supported in SDK hosts" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
	// Optional host extensions ride along only when the host provides them, so
	// hosts without a plan-review dialog keep the classic select fallback.
	if (handlers.planReview) {
		ui.planReview = (plan) => handlers.planReview!(plan);
	}
	return ui;
}

export interface CreatePlusAgentSessionOptions extends CreateAgentSessionOptions {
	/** Additional host extension factories, appended after the pi-plus ones. */
	extensionFactories?: InlineExtension[];
	/**
	 * Dialog handlers for extension UI. When provided, the session is bound
	 * with mode "rpc" and ask_user works through sequential dialogs; when
	 * omitted, the session is bound with mode "print" (no dialogs).
	 */
	ui?: PlusUIDialogHandlers;
	/**
	 * Whether sessions this host writes count as user history — the transcript
	 * header's `interactive` flag, which history surfaces (the Pi+ desktop sidebar,
	 * for one) hide when it is false. Defaults to `ui !== undefined`: a host that
	 * installs dialog handlers has a human driving it, a bare programmatic embed
	 * does not. Process-global because upstream stamps the marker wherever a session
	 * is created (runtimes, `/new`, `/cd`), which no per-call option reaches.
	 */
	interactive?: boolean;
	/** One-shot ExtensionBindings passthroughs (see AgentSession.bindExtensions). */
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: () => void;
	onError?: (error: ExtensionError) => void;
}

/**
 * Create an AgentSession with the pi-plus layer and extensions, for hosts
 * that embed pi in-process instead of running the `pipi` CLI.
 *
 * Differences from the upstream createAgentSession:
 * - the twelve non-TUI pi-plus extensions are registered on the resource loader
 * - the loader is reloaded here (createAgentSession skips reload for a
 *   caller-supplied loader), with one SettingsManager shared by both
 * - extensions are always bound once afterwards, which is what emits the
 *   session start event plus extensions subscribe to (memory recall, hooks);
 *   a host must NOT call bindExtensions again — that would re-emit it
 */
export async function createPlusAgentSession(
	options: CreatePlusAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
	const { extensionFactories, ui, interactive, ...rest } = options;
	// Declared before anything creates a SessionManager; the value also reaches
	// upstream's own session creation through the process-wide default.
	setDefaultSessionInteractive(interactive ?? ui !== undefined);
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [...createPlusSdkExtensionFactories(agentDir), ...(extensionFactories ?? [])],
	});
	await resourceLoader.reload();
	const result = await createAgentSession({
		...rest,
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
	});
	await result.session.bindExtensions({
		uiContext: ui ? createPlusUIContext(ui) : undefined,
		mode: ui ? "rpc" : "print",
		commandContextActions: options.commandContextActions,
		abortHandler: options.abortHandler,
		shutdownHandler: options.shutdownHandler,
		onError: options.onError,
	});
	return result;
}

export interface CreatePlusAgentSessionRuntimeOptions extends CreateAgentSessionOptions {
	/** Additional host extension factories, appended after the pi-plus ones. */
	extensionFactories?: InlineExtension[];
	/**
	 * Dialog handlers for extension UI. When provided, sessions are bound with
	 * mode "rpc" and ask_user works through sequential dialogs; when omitted,
	 * bound with mode "print" (no dialogs).
	 */
	ui?: PlusUIDialogHandlers;
	/**
	 * Whether sessions this host writes count as user history (transcript header
	 * `interactive` flag). Defaults to `ui !== undefined`. Process-global — see
	 * CreatePlusAgentSessionOptions.interactive.
	 */
	interactive?: boolean;
	/**
	 * Override the command-context actions the runtime wires automatically
	 * (waitForIdle / newSession / fork / navigateTree / switchSession / reload
	 * routed to the runtime + current session). Only needed to customize
	 * extension-facing behavior; when omitted the host gets the same routing
	 * the print/RPC CLI modes use, which is what makes /cd and the pi-plus
	 * extensions that replace the session work.
	 */
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: () => void;
	onError?: (error: ExtensionError) => void;
	/**
	 * Called after EVERY extension bind: once for the initial session and again
	 * after each session replacement (switchSession / fork / newSession). The
	 * host must re-subscribe to the new session here — the previous AgentSession
	 * object is disposed after a replacement, so holding onto it is stale.
	 */
	onRebind?: (session: AgentSession) => void | Promise<void>;
	/**
	 * Project-trust flag for per-cwd SettingsManagers (default true). pi's
	 * interactive trust prompt/store is a CLI concern; embedding hosts decide
	 * trust themselves (e.g. a native folder pick counts as consent).
	 */
	projectTrusted?: boolean;
	/**
	 * Loader passthroughs applied on every (re)creation, e.g.
	 * additionalSkillPaths / noSkills / systemPrompt. cwd, agentDir,
	 * settingsManager and extensionFactories are owned by this factory.
	 */
	resourceLoaderOptions?: Omit<
		DefaultResourceLoaderOptions,
		"cwd" | "agentDir" | "settingsManager" | "extensionFactories"
	>;
}

/**
 * Create an AgentSessionRuntime with the pi-plus layer and extensions, for
 * hosts that need CLI-level session replacement (/cd, /new, /fork, /clone,
 * resume-switch) on top of everything createPlusAgentSession provides.
 *
 * Unlike createPlusAgentSession this returns a runtime whose session object
 * CHANGES under the host on every replacement; read the live session via
 * `runtime.session` (or the onRebind callback). Semantics:
 * - the same nine pi-plus extensions are registered per cwd via
 *   createAgentSessionServices, recreating settings/loader against the
 *   effective cwd on switch (mirroring the CLI's runtime factory)
 * - extensions are bound exactly once per session through the rebind hook,
 *   so session_start fires once per session ("startup" initially, then
 *   "resume"/"fork"/"new"/"switch" reasons); the host must NOT call
 *   bindExtensions itself
 * - the initial session uses options.sessionManager when given, otherwise
 *   SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir))
 * - fork/newSession/switchSession may report { cancelled: true } when an
 *   extension vetoes the switch; capability callers should handle it
 */
export async function createPlusAgentSessionRuntime(
	options: CreatePlusAgentSessionRuntimeOptions = {},
): Promise<AgentSessionRuntime> {
	const {
		extensionFactories,
		ui,
		commandContextActions,
		abortHandler,
		shutdownHandler,
		onError,
		onRebind,
		projectTrusted = true,
		resourceLoaderOptions,
		...sessionOptions
	} = options;

	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const sessionInteractive = options.interactive ?? options.ui !== undefined;
	// Process-wide default first: the runtime creates further SessionManagers on
	// `/new`, `/cd`, fork and clone that no option of ours reaches.
	setDefaultSessionInteractive(sessionInteractive);
	const initialSessionManager =
		options.sessionManager ??
		SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir), { interactive: sessionInteractive });

	// Mirrors the CLI factory (coding-agent src/main.ts) trimmed to embedding
	// hosts: services per effective cwd, session created from them, no binding.
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const settingsManager =
			sessionOptions.settingsManager ??
			SettingsManager.create(runtimeOptions.cwd, runtimeOptions.agentDir, { projectTrusted });
		const services = await createAgentSessionServices({
			cwd: runtimeOptions.cwd,
			agentDir: runtimeOptions.agentDir,
			settingsManager,
			modelRuntime: sessionOptions.modelRuntime,
			resourceLoaderOptions: {
				...resourceLoaderOptions,
				// Per-session agent dir (the runtime switches it on /cd too),
				// so spawned sub-agent children pin the live profile.
				extensionFactories: [
					...createPlusSdkExtensionFactories(runtimeOptions.agentDir),
					...(extensionFactories ?? []),
				],
			},
		});
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [...services.diagnostics];
		const extensionsResult = services.resourceLoader.getExtensions();
		for (const { path, error } of extensionsResult.errors) {
			diagnostics.push({ type: "error", message: `Failed to load extension "${path}": ${error}` });
		}
		for (const { path, warning } of extensionsResult.warnings ?? []) {
			diagnostics.push({ type: "warning", message: `Extension package "${path}": ${warning}` });
		}
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			excludeTools: sessionOptions.excludeTools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
		});
		return { ...created, services, diagnostics };
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: initialSessionManager.getCwd(),
		agentDir,
		sessionManager: initialSessionManager,
		sessionStartEvent: sessionOptions.sessionStartEvent,
	});

	// One bind per session, hook-driven (interactive-mode pattern): binding
	// again after a replacement would double-fire session_start and re-run
	// extension session_start side effects (memory recall, hooks).
	const bind = async (session: AgentSession): Promise<void> => {
		await session.bindExtensions({
			uiContext: ui ? createPlusUIContext(ui) : undefined,
			mode: ui ? "rpc" : "print",
			commandContextActions: commandContextActions ?? {
				waitForIdle: () => session.waitForIdle(),
				newSession: (newSessionOptions) => runtime.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtime.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: (targetId, navigateOptions) => session.navigateTree(targetId, navigateOptions),
				switchSession: (sessionPath, switchOptions) => runtime.switchSession(sessionPath, switchOptions),
				reload: async () => {
					await session.reload();
				},
			},
			abortHandler,
			shutdownHandler,
			onError,
		});
		if (onRebind) await onRebind(session);
	};

	runtime.setRebindSession(bind);
	await bind(runtime.session);
	return runtime;
}
