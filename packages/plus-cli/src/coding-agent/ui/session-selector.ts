/**
 * Wrapper for packages/coding-agent/src/modes/interactive/components/session-selector.ts.
 *
 * Keeps headless sessions out of the resume list. The transcript marker itself
 * lives in plus/src/coding-agent/core/session-manager.ts (host mode stamped into
 * the session header at creation); here it is applied where sessions are
 * *displayed*, not where they are resolved: both the `pipi --resume` / `pipi -r`
 * picker (main.ts -> selectSession) and the TUI `/resume` build this component and
 * hand their `SessionManager.list` / `listAll` loaders straight in. The subclass
 * wraps those loaders before `super()` starts its first load, so every path that
 * feeds the list - the resolved array, the partial arrays the picker renders while
 * a large directory is still scanning, and the reload after a delete or rename -
 * goes through the same filter.
 *
 * A session is hidden only when its header says `interactive: false`. Unmarked
 * transcripts (created before the marker, or by a host that never declares a mode)
 * stay visible, and explicit references (`--session <id>`, `-r <id>`) still
 * resolve: this file filters a display list, never `resolveSessionPath`.
 */

export * from "../../../../coding-agent/src/modes/interactive/components/session-selector.ts";

import type { KeybindingsManager } from "../../../../coding-agent/src/core/keybindings.ts";
import { SessionSelectorComponent as UpstreamSelector } from "../../../../coding-agent/src/modes/interactive/components/session-selector.ts";
import type { SessionInfo, SessionListProgress } from "../../../../plus/src/coding-agent/core/session-manager.ts";
import { filterInteractiveSessions } from "../../../../plus/src/coding-agent/core/session-manager.ts";

/** Structural copy of the module-private `SessionsLoader` type upstream. */
type SessionsLoader = (onProgress?: SessionListProgress, signal?: AbortSignal) => Promise<SessionInfo[]>;

type SelectorOptions = {
	renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
	showRenameHint?: boolean;
	keybindings?: KeybindingsManager;
};

/**
 * Filter the partial lists published while a scan is in flight, so a headless
 * transcript never renders before the resolved list replaces it. The progress
 * counts stay as the upstream scan reported them - they describe the work being
 * done, the rows describe what is shown. Ticks are applied in order: a slow header
 * read must not let an older, shorter partial list overwrite a newer one.
 */
function filterProgress(onProgress?: SessionListProgress): SessionListProgress | undefined {
	if (!onProgress) return undefined;
	let latestTick = 0;
	return (loaded, total, partialSessions) => {
		if (!partialSessions) {
			onProgress(loaded, total, undefined);
			return;
		}
		const tick = ++latestTick;
		const sessions = [...partialSessions];
		void filterInteractiveSessions(sessions)
			.then((filtered) => {
				if (tick === latestTick) onProgress(loaded, total, filtered);
			})
			.catch(() => {
				if (tick === latestTick) onProgress(loaded, total, sessions);
			});
	};
}

function hideHeadlessSessions(loader: SessionsLoader): SessionsLoader {
	return (onProgress, signal) =>
		loader(filterProgress(onProgress), signal).then((sessions) => filterInteractiveSessions(sessions));
}

export class SessionSelectorComponent extends UpstreamSelector {
	constructor(
		currentSessionsLoader: SessionsLoader,
		allSessionsLoader: SessionsLoader,
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
		onExit: () => void,
		requestRender: () => void,
		options?: SelectorOptions,
		currentSessionFilePath?: string,
	) {
		super(
			hideHeadlessSessions(currentSessionsLoader),
			hideHeadlessSessions(allSessionsLoader),
			onSelect,
			onCancel,
			onExit,
			requestRender,
			options,
			currentSessionFilePath,
		);
	}
}
