// Registers the pi-plus p2 redirect hooks (./hooks.mjs). Use:
//   node --import ./packages/plus-tui/loader/register.mjs --import ./apps/p2/src/source.ts <p2 entry>
// The redirect table lives in ./p2-redirects.mjs.
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const loaderDir = dirname(fileURLToPath(import.meta.url));
const hooksUrl = pathToFileURL(join(loaderDir, "hooks.mjs")).href;

register(hooksUrl, pathToFileURL(loaderDir).href);
