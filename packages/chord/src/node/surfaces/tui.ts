// The terminal surface's server side (slice 11 §4, decisions "Slice 11, P3" and "P8"): the terminal kind's base bundle
<<<<<<< HEAD
// (one ES module the sandbox evaluates) built from the app's terminal entry after the server's start (`build`; the
// launcher's start and the surface's files wait for it, and answer 503 when it failed), the kind's plugin scripts
// published as registered scripts and one combined file, `TuiScripts` showing the current set, all served to the
// launcher, which signs in with a token. Routes and objects are `Http` contributions of the surface's facet.

=======
// (one ES module the sandbox evaluates) built from the app's terminal entry at start, the kind's plugin scripts
// published as registered scripts and one combined file, `TuiScripts` showing the current set, all served to the
// launcher, which signs in with a token. Routes and objects are `Http` contributions of the surface's facet.

import type { Context } from "../../context/index.ts";
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { Http, type HttpRequest, type HttpResponse } from "../http/index.ts";
import type { Plugins, RolloutStep } from "../plugins/index.ts";
<<<<<<< HEAD
import { scriptsFacet } from "./current.ts";
import { SurfaceBuild, type SurfaceBuilt } from "./surface-build.ts";
=======
import { buildBase } from "./bundle.ts";
import { scriptsFacet } from "./current.ts";
import { PublishedScripts } from "./published.ts";
import { type ServedFile, served } from "./served.ts";
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)

/** What `tuiSurface` takes. */
export type TuiSurfaceOptions = {
	/** The terminal facet kind: `tui` by default. */
	readonly kind?: string;
	readonly plugins: Plugins;
	/** The app's terminal start code (it calls `startTerminalRuntime`): the base bundle's entry. */
	readonly entry: string;
<<<<<<< HEAD
	/** The conditions the base bundle's packages resolve with: the server process's by default (`processConditions`). */
	readonly conditions?: readonly string[];
	/** A tsconfig.json whose `paths` the base bundle's packages resolve through, as the server's loader does (`BaseResolution`). */
	readonly tsconfig?: string;
=======
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
};

/** What a launcher downloads at its start (`GET /_chord/tui/start`): the base bundle and the combined plugin file. */
export type TuiStart = { readonly base: string; readonly script: string; readonly combined: string };

<<<<<<< HEAD
/** The terminal surface: its facet (for the server's core facets), its rollout step, its build. */
export type TuiSurface<P extends Principal> = {
	readonly facet: Facet<P>;
	step(name: string): RolloutStep;
	/**
	 * Builds the base bundle and publishes the terminal kind's first set, once, after the server's load (the launcher's
	 * start and the surface's files wait for it, and start it when nothing did). Never rejects: how it ended.
	 */
	build(): Promise<SurfaceBuilt>;
	/** How the build ended, once it did. */
	readonly built: SurfaceBuilt | undefined;
=======
/** The terminal surface: its facet (for the server's core facets), its rollout step, its base bundle's hash. */
export type TuiSurface<P extends Principal> = {
	readonly facet: Facet<P>;
	step(name: string): RolloutStep;
	readonly base: string;
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
};

/** Where the terminal surface's files live. */
export const TUI_PREFIX = "/_chord/tui/";

<<<<<<< HEAD
/**
 * The terminal surface on `server`: its facet serves the launcher's start and the surface's files once `build` built
 * the base bundle (503 when it failed). The build is not started here.
 */
export function tuiSurface<P extends Principal>(server: Host<P>, options: TuiSurfaceOptions): TuiSurface<P> {
	const { kind = "tui", entry, conditions, tsconfig, plugins } = options;
	const resolution = {
		...(conditions === undefined ? {} : { conditions }),
		...(tsconfig === undefined ? {} : { tsconfig }),
	};
	const building = new SurfaceBuild<P>("tui", "sandbox", TUI_PREFIX, { kind, entry, resolution, plugins }, server);
	const serve = async (request: HttpRequest): Promise<HttpResponse> => building.file(request.path);
	const facet = defineFacet<P>((host, self) => {
		scriptsFacet<P>("tui", building).setup(host, self);
		self.contribute(Http, {
			routes: {
				[`GET ${TUI_PREFIX}start`]: async () => {
					const parts = await building.parts();
					if (parts === undefined) return { kind: "error", status: 503 };
					const { base, published } = parts;
=======
/** Builds the terminal's base bundle and takes the kind's current set, then returns the surface. */
export async function tuiSurface<P extends Principal>(
	server: Host<P>,
	options: TuiSurfaceOptions,
	context: Context,
): Promise<TuiSurface<P>> {
	const base = await buildBase(options.entry, "sandbox", TUI_PREFIX);
	const published = new PublishedScripts("tui", options.kind ?? "tui", TUI_PREFIX, base.hash, options.plugins, server);
	await published.start(context);
	const file = (path: string): ServedFile | undefined => base.files.get(path) ?? published.file(path);
	const serve = async (request: HttpRequest): Promise<HttpResponse> => served(file(request.path));
	const facet = defineFacet<P>((host, self) => {
		scriptsFacet<P>("tui", published).setup(host, self);
		self.contribute(Http, {
			routes: {
				[`GET ${TUI_PREFIX}start`]: async () => {
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
					const start: TuiStart = { base: base.hash, script: base.script, combined: published.set.combined };
					return { kind: "json", value: start, headers: { "Cache-Control": "no-store" } };
				},
				[`GET ${TUI_PREFIX}base`]: {
					public: true,
<<<<<<< HEAD
					handler: async () => {
						const parts = await building.parts();
						if (parts === undefined) return { kind: "error", status: 503 };
						return { kind: "json", value: parts.base.hash, headers: { "Cache-Control": "no-store" } };
					},
=======
					handler: async () => ({ kind: "json", value: base.hash, headers: { "Cache-Control": "no-store" } }),
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
				},
				[`GET ${TUI_PREFIX}:file`]: serve,
				[`GET ${TUI_PREFIX}plugin/:file`]: serve,
			},
		});
	});
<<<<<<< HEAD
	return {
		facet,
		step: (name) => building.step(name),
		build: () => building.build(),
		get built() {
			return building.built;
		},
	};
=======
	return { facet, step: (name) => published.step(name), base: base.hash };
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
}
