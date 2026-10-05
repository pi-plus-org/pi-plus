/**
 * Per-session plan mode state.
 *
 * State lives for the lifetime of the extension runtime: it survives
 * `/reload` (the runtime is reused) and is reset on session replacement
 * (`new`/`resume`/`fork`) in the session_start handler.
 *
 * The state lives in a module-level holder shared with the permissions
 * extension (`sharedPlanGateState`): plan mode activates both the plan
 * extension's gate and the permission mode "plan" gate, and both must agree
 * on the plan-file carve-out or the second gate blocks writes to the plan
 * file itself.
 */

export interface PlanModeState {
	enabled: boolean;
	planFilePath: string | undefined;
}

export function createPlanState(): PlanModeState {
	return { enabled: false, planFilePath: undefined };
}

/**
 * Process-wide plan-mode state, used by the plan extension as its live state
 * and read by the permissions extension's "plan" gate so both gates share
 * the same plan-file carve-out. Reset on session replacement.
 */
export const sharedPlanGateState: PlanModeState = createPlanState();
