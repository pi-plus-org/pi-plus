/**
 * Full-barrel mirror of packages/agent/src/index.ts with the pi-plus Agent
 * override (abort guard + effort model, see ./agent.ts).
 *
 * This module exists for the pi-agent-core test alias in
 * packages/plus-api/vitest.config.ts: the alias redirects the whole
 * @earendil-works/pi-agent-core package here so SDK tests exercise the
 * plus-extended Agent from source — the test-time mirror of the loader
 * redirect for packages/agent/src/agent.ts in the pipi and pi-plus-sdk
 * bundles (where the upstream barrel's `export * from "./agent.ts"` picks up
 * the plus wrapper instead). It is not part of the bundle redirect table.
 *
 * The explicit `export { Agent }` shadows the upstream Agent that the
 * preceding `export *` pulls in — explicit named exports win over
 * star-export conflicts.
 */
export * from "../../../agent/src/index.ts";
export { Agent } from "./agent.ts";
