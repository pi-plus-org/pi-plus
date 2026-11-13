/**
 * Wrapper for packages/coding-agent/src/core/agent-session.ts.
 *
 * Everything passes through to the upstream module except:
 * - AgentSession.compact -> serialized through a per-session queue; calls
 *   arriving while a compaction is in flight join it instead of queueing
 *   behind it; and when a run is active, upstream's "nothing to compact"
 *   failures are pre-flighted BEFORE its abort() (which by contract kills the
 *   run first, stranding the task for a compaction that does nothing).
 *   Upstream keeps the manual compaction's abort controller in a singleton
 *   field that any overlapping compaction's cleanup resets to undefined;
 *   overlapping manual compactions (e.g. context-guard's resume compaction
 *   plus a user /compact) then crash with "Cannot read properties of
 *   undefined (reading 'signal')" and never emit compaction_end, stranding the
 *   TUI's compaction indicator (see compaction/serialize.ts). Queueing the
 *   second one instead fixes the crash but strands the task a different way:
 *   it starts the moment the first compaction lands, aborts the
 *   freshly-resumed run, and fails with "Nothing to compact (session too
 *   small)" (see the override's comment).
 *   The override also resumes the interrupted task — whether the compaction
 *   lands or fails: compact() aborts an in-flight run by contract and never
 *   continues it, which stranded the task whenever context-guard fired its
 *   threshold/message-count trigger mid-run (or the user ran /compact during
 *   a run). When compact() started while a run was active, a silent
 *   continuation message re-engages the model afterwards (see
 *   compaction/resume.ts). PI_COMPACT_DEBUG=1 traces every compact() entry,
 *   join, and pre-flight block with a call stack to
 *   ~/.pi/agent/pi-plus-compact-debug.log (see compaction/trace.ts).
 * - AgentSession.getContextUsage -> estimates context right after compaction instead
 *   of reporting "unknown" (see plus/src/context/usage.ts)
 * - AgentSession constructor and AgentSession.prompt -> apply time-based
 *   micro-compact (clearing stale tool results) before the run rebuilds the
 *   dead prompt-cache prefix: once at (re)open and then per prompt submission,
 *   so sessions idling while open match CC's pre-request evaluation (see
 *   plus/src/context/microcompact.ts)
 * - AgentSession constructor -> on Windows without any bash (no Git Bash, none
 *   on PATH) and no user-configured shellPath, the built-in "bash" tool can
 *   never succeed, so it is excluded and "powershell" takes its slot in the
 *   active toolset (see applyWindowsShellFallback below)
 * - AgentSession.getSlashCommands -> pi-plus addition (no upstream equivalent):
 *   the session-executable slash-command set for embedding hosts, exposed on
 *   this subclass so the SDK bundle's redirects hand hosts the same class
 *   upstream factories use (see the getSlashCommands doc below)
 */
export * from "../../../../coding-agent/src/core/agent-session.ts";

import {
	type AgentSessionConfig,
	type PromptOptions,
	AgentSession as UpstreamAgentSession,
} from "../../../../coding-agent/src/core/agent-session.ts";
import { type CompactionResult, prepareCompaction } from "../../../../coding-agent/src/core/compaction/compaction.ts";
import type { ContextUsage } from "../../../../coding-agent/src/core/extensions/types.ts";
import type { SlashCommandInfo } from "../../../../coding-agent/src/core/slash-commands.ts";
import type { SourceInfo } from "../../../../coding-agent/src/core/source-info.ts";
import { getShellConfig } from "../../../../coding-agent/src/utils/shell.ts";
import { resumeAfterMidRunCompact } from "../../compaction/resume.ts";
import { createAsyncSerializer } from "../../compaction/serialize.ts";
import { traceCompactionCall } from "../../compaction/trace.ts";
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

/** The upstream privates getSlashCommands reads through a structural cast. */
interface SlashCommandSources {
	_extensionRunner?: {
		getRegisteredCommands(): { invocationName: string; description?: string; sourceInfo: SourceInfo }[];
	};
	_resourceLoader: {
		getSkills(): { skills: { name: string; description?: string; sourceInfo: SourceInfo }[] };
	};
}

export class AgentSession extends UpstreamAgentSession {
	// Serializes manual compact() calls (resume-triggered, /compact, RPC, SDK)
	// so only one runs at a time; the queue waits for the previous compaction's
	// finally blocks as well, which is exactly what prevents the shared abort
	// controller from being cleared mid-handoff.
	private readonly serializeCompaction = createAsyncSerializer();

	// The manual compaction currently in flight, if any. Calls arriving while
	// this is set join it instead of queueing behind it (see the compact()
	// override). Cleared by the queued fn's settle, not before.
	private compactionInFlight: Promise<CompactionResult> | undefined;

	// A resume was dispatched after a compaction but its re-engaged run has
	// not settled yet. Covers the window between the resume's fire-and-forget
	// dispatch and the run actually showing up as isStreaming, so a compact()
	// arriving there still treats the task as active (pre-flight + resume).
	private compactionResumePending = false;

	constructor(config: AgentSessionConfig) {
		super(applyWindowsShellFallback(config));
		this.runIdleMicroCompact();
	}

	override async prompt(text: string, options?: PromptOptions): Promise<void> {
		// CC evaluates the time-based micro-compact trigger before every API call.
		// The constructor check only covers session open, so a session that stays
		// open past the idle window (desktop app) must clear stale tool results on
		// the next submission, before the run rebuilds the dead cache prefix. A gap
		// cannot accrue mid-run (assistant timestamps refresh), so per-prompt
		// evaluation matches CC; the projection-based selection is idempotent.
		this.runIdleMicroCompact();
		await super.prompt(text, options);
	}

	private runIdleMicroCompact(): void {
		try {
			applyIdleMicroCompact(this.sessionManager);
		} catch (error) {
			// Micro-compact must never break session construction or a prompt.
			console.error("pi-plus: idle micro-compact failed:", error);
		}
	}

	/**
	 * Slash commands invokable through prompt(): extension-registered
	 * commands, file prompt templates, and skills (as `skill:<name>`). This is
	 * the TUI autocomplete set minus the interactive-mode-only builtins. Reads
	 * the live runner, so extension reloads are reflected. pi-plus addition for
	 * embedding hosts (e.g. a desktop composer's `/...` menu) — upstream's
	 * extension core recomputes the same set through a private closure, so the
	 * TUI/extension behavior is unchanged.
	 */
	getSlashCommands(): SlashCommandInfo[] {
		const internals = this as unknown as SlashCommandSources;
		const extensionCommands: SlashCommandInfo[] = (internals._extensionRunner?.getRegisteredCommands() ?? []).map(
			(command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension" as const,
				sourceInfo: command.sourceInfo,
			}),
		);
		const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
			name: template.name,
			description: template.description,
			source: "prompt" as const,
			sourceInfo: template.sourceInfo,
		}));
		const skills: SlashCommandInfo[] = internals._resourceLoader.getSkills().skills.map((skill) => ({
			name: `skill:${skill.name}`,
			description: skill.description,
			source: "skill" as const,
			sourceInfo: skill.sourceInfo,
		}));
		return [...extensionCommands, ...templates, ...skills];
	}

	override compact(customInstructions?: string): Promise<CompactionResult> {
		traceCompactionCall({
			stage: "enter",
			customInstructions,
			isStreaming: this.isStreaming,
			joinActive: this.compactionInFlight !== undefined,
			resumePending: this.compactionResumePending,
		});
		// Join a compaction that is already in flight instead of queueing a
		// second one behind it. Production bug (pi-plus-desktop session
		// 01a138f0): the context-guard fired its threshold compaction mid-run
		// (a 70s summary); a manual /compact issued during that window executed
		// immediately (the TUI checks queued-during-compaction input only after
		// the /compact intercept, and the desktop IPC path can race the same
		// way), the serializer queued it behind the running compaction, and it
		// started the moment the first landed — aborting the freshly-resumed
		// run (the resume's custom message never persisted) and then failing
		// prepareCompaction with "Nothing to compact (session too small)",
		// because the just-landed compaction had already shrunk the session. A
		// second caller asking to compact while a compaction is summarizing is
		// asking for exactly what is happening: hand it the in-flight result
		// (its customInstructions, if any, are dropped — the running
		// compaction cannot be re-parameterized).
		if (this.compactionInFlight) {
			traceCompactionCall({
				stage: "join",
				customInstructions,
				isStreaming: this.isStreaming,
				joinActive: true,
				resumePending: this.compactionResumePending,
			});
			return this.compactionInFlight;
		}
		const promise = this.serializeCompaction(async () => {
			// Capture before super.compact(): the manual path aborts the
			// in-flight run, so isStreaming is false long before the result
			// comes back. The resume-pending flag covers the window between a
			// previous compaction's resume dispatch and the re-engaged run
			// starting to stream. A run interrupted this way is never
			// continued upstream — it must be resumed whichever way the
			// compaction ends.
			const interruptedRun = this.isStreaming || this.compactionResumePending;
			// Pre-flight the "nothing to compact" failures BEFORE the abort.
			// Upstream compact() starts with `await this.abort()`, so a
			// compaction that turns out to have no material still kills the
			// running task first — that is exactly the stranding observed when
			// a caller (the production trace: ~10ms after a compaction landed,
			// outside the join window) asks for a second compaction on the
			// just-shrunk session. If there is nothing to compact, reject
			// without aborting: the run survives, the caller learns why, and
			// no "Compaction failed" error line follows an aborted task.
			// Only checked when a run would be at risk; the idle path keeps
			// upstream's exact behavior and events.
			const blocker = interruptedRun ? this.findCompactionBlocker() : undefined;
			if (blocker) {
				traceCompactionCall({
					stage: "block",
					customInstructions,
					isStreaming: this.isStreaming,
					joinActive: false,
					resumePending: this.compactionResumePending,
					blocker,
				});
				throw new Error(blocker);
			}
			try {
				return await super.compact(customInstructions);
			} finally {
				// Resume on BOTH paths: super.compact() aborted the run before
				// it could fail (summary provider error, cancellation, a race
				// past the pre-flight), and a failed compaction must not leave
				// the task stranded either — the abort was for nothing.
				if (interruptedRun) {
					this.compactionResumePending = true;
					void resumeAfterMidRunCompact(this).finally(() => {
						this.compactionResumePending = false;
					});
				}
			}
		});
		this.compactionInFlight = promise;
		// Settle handler on the queued promise itself: clears the join target
		// once this compaction (and its resume dispatch) has finished, so a
		// call that arrives a beat later starts a fresh compaction.
		void promise
			.catch(() => {})
			.finally(() => {
				if (this.compactionInFlight === promise) this.compactionInFlight = undefined;
			});
		return promise;
	}

	/**
	 * Replicates upstream compact()'s pre-abort failure checks (model missing
	 * excepted — a run always has one): returns the message compact() would
	 * throw with after aborting the run, or undefined when there is material
	 * to compact. Same prepareCompaction inputs, same throw sites, kept in
	 * sync with packages/coding-agent/src/core/agent-session.ts compact().
	 */
	private findCompactionBlocker(): string | undefined {
		const model = this.model;
		if (!model) return undefined; // let the idle/no-run upstream path report it
		const settings = this.settingsManager.getCompactionSettings(model);
		const pathEntries = this.sessionManager.getBranch();
		if (prepareCompaction(pathEntries, settings)) return undefined;
		const lastEntry = pathEntries[pathEntries.length - 1];
		if (lastEntry?.type === "compaction") return "Already compacted";
		return "Nothing to compact (session too small)";
	}

	override getContextUsage(): ContextUsage | undefined {
		return getContextUsagePlus(this);
	}
}
