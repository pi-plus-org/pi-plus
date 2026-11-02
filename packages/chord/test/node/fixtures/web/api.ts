<<<<<<< HEAD
// The web API of the browser tests (`@test/app/v1/web`): the `Panels` and `Parts` registries web plugins contribute and
// the page's counter and beats, local objects of the page.

import { defineRegistry, event, int, local, method } from "../../../../src/index.ts";
=======
// The web API of the browser tests (`@test/app/v1/web`): the `Panels` registry web plugins contribute and the page's
// counter, a local object of the page.

import { defineRegistry, int, local, method } from "../../../../src/index.ts";
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)

/** Panel titles, in plugin-name order. */
export const Panels = defineRegistry<string, readonly string[]>("test.panels", { version: 1 });

<<<<<<< HEAD
/** Parts of the page: components (a function making an element), in plugin-name order. */
export const Parts = defineRegistry<() => unknown, readonly (() => unknown)[]>("test.parts", { version: 1 });

=======
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
/** The page's counter. */
export const Counter = local("test.counter", {
	version: 1,
	params: {},
	members: { count: int(), increment: method() },
});
<<<<<<< HEAD

/** The page's beats: two event members (`useEvents`). */
export const Beats = local("test.beats", { version: 1, params: {}, members: { a: event(int()), b: event(int()) } });
=======
>>>>>>> b18ab67cb (feat(chord): Chord v2 is the package's root)
