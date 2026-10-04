/**
 * pi-plus-session-recap: auto-generate a short session title ("recap") and
 * apply it as the session name, so the tab title and the legacy resume list
 * (session-selector `name ?? firstMessage`) show what the session is about
 * instead of the raw first prompt or just the cwd.
 *
 * Triggers (both make one off-the-side LLM title call, see generate.ts):
 * - agent_settled, when the session holds exactly one user message: the first
 *   prompt has just been answered.
 * - session_compact (manual / threshold / overflow): the recap is refreshed
 *   from the compaction summary, which replaces the whole earlier context.
 *
 * Never clobbers a manual rename: `session_info_changed` for a name that is
 * not ours locks the session. Ours are identified two ways — an in-process
 * flag for writes made here, and a persisted `pi-plus-session-recap` custom
 * entry recording the auto-set name, so a resumed session knows whether its
 * existing name was a previous recap (refreshable) or a human's (locked).
 *
 * Recaps are best-effort: everything runs serialized through
 * createAsyncSerializer (a first-prompt recap and an overflow-compaction
 * recap must not overlap), fire-and-forget, and failures are logged, never
 * surfaced. Unpersisted sessions (no session file) are skipped.
 */

import { serializeConversation } from "../../../../coding-agent/src/core/compaction/utils.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../../coding-agent/src/core/extensions/types.ts";
import { convertToLlm } from "../../../../coding-agent/src/core/messages.ts";
import { createAsyncSerializer } from "../../compaction/serialize.ts";
import { generateRecapTitle, type RecapGenerationOptions } from "./generate.ts";

/** Custom entry marking "this session name was auto-set by the recap". */
const RECAP_ENTRY_TYPE = "pi-plus-session-recap";

interface RecapMarkerData {
	name?: unknown;
}

/** Injectable for tests (the memory tools use the same deps pattern). */
export interface RecapDeps {
	generateTitle?: (options: RecapGenerationOptions) => Promise<string>;
}

/**
 * Everything the async recap needs, read synchronously while the event
 * handler runs: the extension ctx throws assertActive() once the runtime is
 * torn down, which in print mode happens right after agent_settled, before
 * any scheduled recap could resume.
 */
interface RecapContextSnapshot {
	persisted: boolean;
	sessionId: string;
	model: RecapGenerationOptions["model"] | undefined;
	registry: Pick<ExtensionContext["modelRegistry"], "getApiKeyAndHeaders">;
}

export function registerRecap(pi: ExtensionAPI, deps: RecapDeps = {}): void {
	const generateTitle = deps.generateTitle ?? generateRecapTitle;
	const serialize = createAsyncSerializer();
	// True once a manual rename (or a pre-existing non-recap name) is seen:
	// the recap stops touching the session name for this session's lifetime.
	let manualName = false;
	// Name last auto-applied here (or restored from the marker at start).
	let autoName: string | undefined;
	// Whether the first-prompt trigger has fired for the current session; also
	// claimed by any scheduled recap so a compaction during the first run does
	// not double up with the settle handler afterwards.
	let firstPromptHandled = false;
	// Guards our own setSessionName against re-entering session_info_changed.
	let applyingRecap = false;

	const scheduleRecap = (conversationText: string, snapshot: RecapContextSnapshot): void => {
		// Fire-and-forget: the serializer swallows nothing, so catch here to
		// keep a failed recap from becoming an unhandled rejection.
		serialize(async () => {
			try {
				if (manualName) return;
				if (!snapshot.persisted) return;
				const model = snapshot.model;
				if (!model) return;
				const auth = await snapshot.registry.getApiKeyAndHeaders(model);
				if (!auth.ok) return;
				const title = await generateTitle({
					conversationText,
					model,
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					sessionId: snapshot.sessionId,
				});
				// A rename may have landed while the title call was in flight.
				if (manualName) return;
				applyingRecap = true;
				try {
					autoName = title;
					pi.setSessionName(title);
					pi.appendEntry(RECAP_ENTRY_TYPE, { name: title } satisfies RecapMarkerData);
				} finally {
					applyingRecap = false;
				}
			} catch (error) {
				// A session replacement (fork / /cd / resume-switch) landed while
				// the title call was in flight: the captured pi is stale, so the
				// write is correctly refused. The title is intentionally
				// discarded — best-effort by design, not an error worth logging.
				if (error instanceof Error && error.message.includes("extension ctx is stale")) return;
				console.error("pi-plus: session recap failed:", error);
			}
		}).catch(() => {});
	};

	pi.on("session_start", (_event, ctx) => {
		firstPromptHandled = false;
		// Scan persisted markers for the newest auto-set name. The current name
		// is "ours" (refreshable on compaction) only if it matches that marker.
		let lastMarkerName: string | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === RECAP_ENTRY_TYPE) {
				const data = entry.data as RecapMarkerData | undefined;
				if (typeof data?.name === "string") lastMarkerName = data.name;
			}
		}
		autoName = lastMarkerName;
		const currentName = ctx.sessionManager.getSessionName();
		// An existing name means the first-prompt moment is already past.
		firstPromptHandled = currentName !== undefined;
		manualName = currentName !== undefined && currentName !== lastMarkerName;
	});

	pi.on("session_info_changed", (event, _ctx) => {
		// Own writes (sync re-entry guard + name-match guard; the runner also
		// delivers this event asynchronously after applyingRecap resets).
		if (applyingRecap || event.name === autoName) return;
		// Anything else — TUI rename, rename via other surfaces, clear — locks.
		manualName = true;
	});

	const snapshotContext = (ctx: ExtensionContext): RecapContextSnapshot => ({
		persisted: ctx.sessionManager.getSessionFile() !== undefined,
		sessionId: ctx.sessionManager.getSessionId(),
		model: ctx.model,
		registry: ctx.modelRegistry,
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (manualName || firstPromptHandled) return;
		const projection = ctx.sessionManager.buildSessionProjection();
		// "First prompt answered" means exactly one user message on the branch.
		if (projection.messages.filter((message) => message.role === "user").length !== 1) return;
		firstPromptHandled = true;
		const snapshot = snapshotContext(ctx);
		scheduleRecap(serializeConversation(convertToLlm(projection.messages)), snapshot);
	});

	pi.on("session_compact", (event, ctx) => {
		if (manualName) return;
		// The summary replaces everything before the cut point, so it is the
		// recap input; also claim the first-prompt trigger (a compaction during
		// the first run covers it).
		firstPromptHandled = true;
		const snapshot = snapshotContext(ctx);
		scheduleRecap(event.compactionEntry.summary, snapshot);
	});
}
