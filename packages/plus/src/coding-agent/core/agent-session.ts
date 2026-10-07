/**
 * Wrapper for packages/coding-agent/src/core/agent-session.ts.
 *
 * Everything passes through to the upstream module except:
 * - AgentSession.compact -> serialized through a per-session queue. Upstream
 *   keeps the manual compaction's abort controller in a singleton field that
 *   any overlapping compaction's cleanup resets to undefined; overlapping
 *   manual compactions (e.g. context-guard's resume compaction plus a user
 *   /compact) then crash with "Cannot read properties of undefined (reading
 *   'signal')" and never emit compaction_end, stranding the TUI's compaction
 *   indicator (see compaction/serialize.ts).
 * - AgentSession.getContextUsage -> estimates context right after compaction instead
 *   of reporting "unknown" (see plus/src/context/usage.ts)
 * - AgentSession constructor -> applies time-based micro-compact (clearing stale
 *   tool results) once per (re)opened session, before the first request rebuilds
 *   the dead prompt-cache prefix (see plus/src/context/microcompact.ts)
 * - AgentSession constructor -> on Windows without any bash (no Git Bash, none
 *   on PATH) and no user-configured shellPath, the built-in "bash" tool can
 *   never succeed, so it is excluded and "powershell" takes its slot in the
 *   active toolset (see applyWindowsShellFallback below)
 */
export * from "../../../../coding-agent/src/core/agent-session.ts";

import {
	type AgentSessionConfig,
	AgentSession as UpstreamAgentSession,
} from "../../../../coding-agent/src/core/agent-session.ts";
import type { CompactionResult } from "../../../../coding-agent/src/core/compaction/compaction.ts";
import type { ContextUsage } from "../../../../coding-agent/src/core/extensions/types.ts";
import { getShellConfig } from "../../../../coding-agent/src/utils/shell.ts";
import { createAsyncSerializer } from "../../compaction/serialize.ts";
import { applyIdleMicroCompact } from "../../context/microcompact.ts";
import { getContextUsagePlus } from "../../context/usage.ts";

/**
 * Windows shell fallback: the built-in "bash" tool requires Git Bash (or bash
 * on PATH) and fails on every call otherwise, inside the model loop. When no
 * bash is resolvable and the user has not set shellPath, exclude "bash" and
 * swap it for "powershell" in the initial active toolset, so the model gets a
 * working shell with honest PowerShell semantics. Non-Windows platforms, a
 * user-set shellPath, and machines with a resolvable bash are untouched.
 */
export function applyWindowsShellFallback(config: AgentSessionConfig): AgentSessionConfig {
	if (process.platform !== "win32") return config;
	try {
		if (config.settingsManager.getShellPath()) return config;
		getShellConfig(); // throws on Windows when no bash is available
		return config;
	} catch {
		const active = [
			...new Set(
				(config.initialActiveToolNames ?? ["read", "bash", "edit", "write"]).map((name) =>
					name === "bash" ? "powershell" : name,
				),
			),
		];
		return {
			...config,
			excludedToolNames: [...new Set([...(config.excludedToolNames ?? []), "bash"])],
			initialActiveToolNames: active,
		};
	}
}

export class AgentSession extends UpstreamAgentSession {
	// Serializes manual compact() calls (resume-triggered, /compact, RPC, SDK)
	// so only one runs at a time; the queue waits for the previous compaction's
	// finally blocks as well, which is exactly what prevents the shared abort
	// controller from being cleared mid-handoff.
	private readonly serializeCompaction = createAsyncSerializer();

	constructor(config: AgentSessionConfig) {
		super(applyWindowsShellFallback(config));
		try {
			applyIdleMicroCompact(this.sessionManager);
		} catch (error) {
			// Micro-compact must never break session construction.
			console.error("pi-plus: idle micro-compact failed:", error);
		}
	}

	override compact(customInstructions?: string): Promise<CompactionResult> {
		return this.serializeCompaction(() => super.compact(customInstructions));
	}

	override getContextUsage(): ContextUsage | undefined {
		return getContextUsagePlus(this);
	}
}
