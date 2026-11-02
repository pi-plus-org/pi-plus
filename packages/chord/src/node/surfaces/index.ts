// Chord v2's client surfaces, the server side (`@earendil-works/chord/surfaces`; slice 11 §1, §4): the web surface
// (base bundle, plugin scripts, `WebScripts`, the page) and the terminal surface.

<<<<<<< HEAD
export { type BaseBundle, type BasePlatform, type BaseResolution, buildBase, processConditions } from "./bundle.ts";
export type { ServedFile } from "./served.ts";
export type { SurfaceBuilt } from "./surface-build.ts";
export { TUI_PREFIX, type TuiStart, type TuiSurface, type TuiSurfaceOptions, tuiSurface } from "./tui.ts";
export {
	type PageAssets,
	pageBootstrap,
	pageScripts,
	WEB_PREFIX,
	type WebRoutesOptions,
=======
export type { BaseBundle } from "./bundle.ts";
export type { ServedFile } from "./served.ts";
export { TUI_PREFIX, type TuiStart, type TuiSurface, type TuiSurfaceOptions, tuiSurface } from "./tui.ts";
export {
	type PageAssets,
	pageScripts,
	WEB_PREFIX,
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
	type WebSurface,
	type WebSurfaceOptions,
	webSurface,
} from "./web.ts";
