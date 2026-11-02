// Chord v2's React bindings (`@earendil-works/chord/react`; slice 11 §3): optional, non-React apps never load them.

<<<<<<< HEAD
export {
	HostProvider,
	useEvents,
	useHold,
	useHost,
	useMessages,
	usePageState,
	useRefState,
	useRegistry,
	useWatch,
} from "./hooks.ts";
=======
export { HostProvider, useHold, useHost, useRefState, useRegistry, useWatch } from "./hooks.ts";
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
export { type ExternalStore, watchStore } from "./stores.ts";
