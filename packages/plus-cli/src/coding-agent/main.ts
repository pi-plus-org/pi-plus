/**
 * Wrapper for packages/coding-agent/src/main.ts.
 *
 * Adds hub profile support on top of the original CLI entry:
 * - `pipi completion <bash|zsh>` is owned by pi-plus and dispatched before
 *   everything else; it prints a shell completion script and ends the process
 * - hub subcommands (`pipi profile …`, `pipi use`/`pipi unuse`)
 *   are dispatched before pi starts and end the process
 * - `pipi --as <name>` and the stored default profile resolve to a
 *   materialized isolated agent dir; PI_CODING_AGENT_DIR is set in-process
 *   before delegating (getAgentDir() is read lazily, so this is safe)
 * - anything else passes through untouched, with the π+ welcome banner
 *   registered as a hidden built-in extension (TUI startup header)
 */
export * from "../../../coding-agent/src/main.ts";

import type { LaunchPlan } from "@earendil-works/pi-hub";
import {
	dispatchHubCommand,
	findProfile,
	HUB_SUBCOMMANDS,
	materializeProfile,
	resolveLaunch,
} from "@earendil-works/pi-hub";
import { ENV_AGENT_DIR, getAgentDir } from "../../../coding-agent/src/config.ts";
import type { MainOptions } from "../../../coding-agent/src/main.ts";
import { main as upstreamMain } from "../../../coding-agent/src/main.ts";
import { createTerminalAuthInteraction, loginProvider } from "../../../plus/src/auth/login.ts";
import { ENV_BASE_AGENT_DIR } from "../../../plus/src/coding-agent/core/profile-settings.ts";
import {
	createPermissionsExtension,
	registerAskUser,
	registerCd,
	registerContextGuard,
	registerInit,
	registerMemory,
	registerPlan,
	registerRecap,
	registerSubagent,
	registerTasks,
	registerUserHooks,
	registerWebSearch,
} from "../../../plus/src/extensions/index.ts";
import { dispatchCompletion } from "../completion/index.ts";
import { registerChanges, registerFancyDiff, registerPlainTools, registerTabTitle } from "../extensions/index.ts";
import { registerBanner } from "./ui/banner.ts";
// Side-effect import: installs the interactive TUI's rolling auto-fold
// prototype patches (addMessageToChat folds previous turns on a new user
// message; handleEvent folds completed steps as the agent starts the next
// assistant message; PI_AUTO_FOLD_HISTORY=0 disables).
import "./ui/auto-fold-history.ts";
import { registerVim } from "./ui/vim/extension.ts";

export async function main(args: string[], options?: MainOptions) {
	// Plus-owned: completes the whole pipi CLI (hub + native pi commands).
	if (args[0] === "completion") {
		try {
			dispatchCompletion(args.slice(1));
			return;
		} catch (err) {
			console.error("Error:", err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	}

	let plan: LaunchPlan;
	try {
		if (args[0] && HUB_SUBCOMMANDS.has(args[0])) {
			// `profile add <name> -p <provider>` with no credential — or an
			// explicit `--sign-in` on `profile add`/`profile update` — runs the
			// provider's login (OAuth page in the browser / API-key setup) and
			// persists it into the profile's isolated agent dir; hub cannot do
			// this itself (dependency-free), so the CLI injects the capability.
			await dispatchHubCommand(args, {
				login: async (context) => {
					const credential = await loginProvider(context.provider, {
						agentDir: context.profileDir,
						interaction: createTerminalAuthInteraction(),
					});
					// Hub overwrites the profile token with the sign-in result:
					// hand back the key an api-key login produced; an OAuth
					// credential has no single token — it stays in the profile's
					// auth.json and hub clears the field.
					return credential.type === "api_key" && credential.key ? { token: credential.key } : {};
				},
			});
			return;
		}
		plan = resolveLaunch(args);
	} catch (err) {
		console.error("Error:", err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	if (plan.kind === "profile") {
		const profile = findProfile(plan.name);
		if (!profile) {
			console.error(`Error: Profile '${plan.name}' not found. Use 'pipi profile list' to see available profiles.`);
			process.exit(1);
		}
		// ENV_AGENT_DIR is the original config module's constant
		// ("PI_CODING_AGENT_DIR"); the plus config wrapper shadows only the
		// display name, not the env var layout. Record the pre-profile agent
		// dir first: PI_PLUS_BASE_AGENT_DIR activates the runtime settings
		// layering in packages/plus/src/coding-agent/core/settings-manager.ts
		// (~/.pi/agent/settings.json below the profile's settings.json, profile
		// wins), which also makes the old packages exit-sync unnecessary —
		// `packages` is a general key now and is written straight to the base.
		process.env[ENV_BASE_AGENT_DIR] = getAgentDir();
		const profileDir = materializeProfile(plan.name, profile);
		process.env[ENV_AGENT_DIR] = profileDir;
	}

	// The upstream version check polls pi.dev for pi's release train, not pi-plus's.
	process.env.PI_SKIP_VERSION_CHECK = "1";

	// Hidden built-ins: the π+ welcome banner replaces pi's startup header in TUI
	// mode; pi-plus-cd adds /cd, moving the session to a different working
	// directory (the session file relocates to the target cwd's session dir
	// with only its header cwd rewritten, then the runtime switches to it —
	// same conversation, new project context); pi-plus-vim enables vim modal
	// editing when the "vim" setting is on;
	// pi-plus-subagent delegates tasks to isolated sub-agent processes;
	// pi-plus-tasks adds the TaskCreate/TaskUpdate/TaskList/TaskGet tools and the
	// /tasks command (ctrl+y); pi-plus-memory adds per-project long-term memory
	// (memory_save/memory_recall tools, MEMORY.md index injected into the system
	// prompt, /memory command, background extraction of noteworthy facts at turn
	// end); pi-plus-plan adds plan mode (EnterPlanMode /
	// ExitPlanMode tools, /plan command, ctrl+alt+p toggle) — a read-only
	// research phase whose plan file is the only writable target until the user
	// approves via ExitPlanMode; pi-plus-ask-user adds the ask_user tool, letting
	// the model ask 1-4 structured questions (options, multi-select, free-text
	// Other) mid-task in TUI/RPC modes; pi-plus-hooks fires command hooks
	// declared in settings.json under a "hooks" key on PermissionRequest /
	// PreToolUse / Stop analogues; pi-plus-tab-title owns the terminal tab
	// title ("pi+ - [name -] dir") and prepends a spinner frame while the
	// agent is working; pi-plus-plain-tools strips the background fills from
	// tool result blocks (upstream paints them pending/success/error) so tool
	// status reads as text, consistent with the subagent tool's word-based
	// status; pi-plus-fancy-diff takes over the edit/write tool renderers in the
	// TUI: syntax-highlighted diff bodies, colored +/- markers, a dim
	// line-number gutter, +N −M change stats with a language badge, bold
	// word-level emphasis on modified lines, and an old-vs-new diff when write
	// overwrites an existing file (pre-image captured in a tool_call handler);
	// pi-plus-init adds /init, which analyzes the codebase and creates
	// or improves AGENTS.md at the cwd root (pi already loads AGENTS.md into
	// every session, so the extension only owns the command); pi-plus-web-search
	// adds WebSearch (provider chain over WEB_SEARCH_PROVIDER/*_API_KEY env vars,
	// keyless DuckDuckGo fallback last) and WebFetch (URL → text); pi-plus-permissions
	// adds the /permissions command and the tool-call permission gate (bypass |
	// accept-edits | plan; bypass is the default, so behavior stays pi-like until
	// the user switches — in TUI mode accept-edits prompts through the dialog UI).
	// Merged with any caller-provided factories; upstream appends its own
	// built-ins (main.ts: extensionFactories = [...builtInExtensions, ...]).
	const merged: MainOptions = {
		...options,
		extensionFactories: [
			...(options?.extensionFactories ?? []),
			{ name: "pi-plus-banner", factory: registerBanner, hidden: true },
			{ name: "pi-plus-cd", factory: registerCd, hidden: true },
			{ name: "pi-plus-vim", factory: registerVim, hidden: true },
			{ name: "pi-plus-subagent", factory: registerSubagent, hidden: true },
			{ name: "pi-plus-tasks", factory: registerTasks, hidden: true },
			{ name: "pi-plus-memory", factory: registerMemory, hidden: true },
			{ name: "pi-plus-plan", factory: registerPlan, hidden: true },
			createPermissionsExtension(),
			{ name: "pi-plus-session-recap", factory: registerRecap, hidden: true },
			{ name: "pi-plus-ask-user", factory: registerAskUser, hidden: true },
			{ name: "pi-plus-hooks", factory: registerUserHooks, hidden: true },
			{ name: "pi-plus-context-guard", factory: registerContextGuard, hidden: true },
			{ name: "pi-plus-init", factory: registerInit, hidden: true },
			{ name: "pi-plus-web-search", factory: registerWebSearch, hidden: true },
			{ name: "pi-plus-tab-title", factory: registerTabTitle, hidden: true },
			{ name: "pi-plus-plain-tools", factory: registerPlainTools, hidden: true },
			{ name: "pi-plus-fancy-diff", factory: registerFancyDiff, hidden: true },
			{ name: "pi-plus-changes", factory: registerChanges, hidden: true },
		],
	};
	return upstreamMain(plan.remainingArgs, merged);
}
