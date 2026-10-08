/**
 * Failure surfacing for the pi-plus-session-recap extension.
 *
 * Recap runs are best-effort and fire-and-forget, so a failure must never
 * disrupt the session — but both the CLI (a transcript warning instead of a
 * stderr stack trace) and SDK hosts (their own status UI) want to know when
 * one happens, and why. This module is the in-process fan-out: the extension
 * publishes every failure with a discriminated reason, and anyone (TUI
 * bridge, embedding host) subscribes. Mirrors the module-level
 * subscribeToTasks pattern (extensions/tasks/store.ts).
 */

/** Why a recap run failed: the title call timed out, or the provider errored. */
export type RecapFailureReason = "timeout" | "error";

/** One failed recap run. */
export interface RecapFailure {
	/** Session that owned the recap run. */
	sessionId: string;
	reason: RecapFailureReason;
	/** Human-readable detail (timeout note or the provider error message). */
	message: string;
}

type RecapFailureListener = (failure: RecapFailure) => void;

const listeners = new Set<RecapFailureListener>();

/**
 * Subscribe to recap failures from every session in this process. In-process
 * only — hosts embed pi-plus in-process, which this covers. Returns an
 * unsubscribe function.
 */
export function subscribeToRecapFailures(listener: RecapFailureListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Fan a failure out to subscribers; a throwing listener must not break the recap. */
export function publishRecapFailure(failure: RecapFailure): void {
	for (const listener of [...listeners]) {
		try {
			listener(failure);
		} catch {
			/* subscriber isolation: best-effort fan-out */
		}
	}
}
