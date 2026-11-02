// Chord v2's workers component (`@earendil-works/chord/workers`, slice 10 §3, §4): a forked worker process per
// address of a host kind, started on demand, stopped when idle, never restarted by itself, its plugins shipped from the
<<<<<<< HEAD
// server; `workerMain` is the worker's side (also `@earendil-works/chord/workers/child`, without esbuild). Node-only.

export { nodeBaseInputs } from "./base.ts";
export * from "./child.ts";
=======
// server; `workerMain` is the worker's side. Node-only.

export type { CrossedError } from "./control.ts";
export { type ProcessLock, processLock } from "./lock.ts";
export {
	type WorkerMainOptions,
	type WorkerPlugins,
	type WorkerResult,
	type WorkerStart,
	workerMain,
} from "./main.ts";
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
export {
	createWorkers,
	type WorkerState,
	type Workers,
<<<<<<< HEAD
	type WorkersBuilt,
=======
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
	type WorkersError,
	type WorkersOptions,
} from "./workers.ts";
