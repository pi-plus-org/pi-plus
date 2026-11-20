// ESM resolve hook for the pi-plus p2: redirects the modules in ./p2-redirects.mjs to their plus-tui
// extensions. Registered by ./register.mjs; importers inside packages/plus-tui/ are exempt so the
// wrappers' relative imports back into packages/tui and apps/p2 resolve the original modules.
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redirects } from "./p2-redirects.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const exemptPrefixes = ["packages/plus-tui/"].map((prefix) => join(repoRoot, prefix));

const redirectByFile = new Map(
	redirects.map(([original, wrapper]) => [normalize(join(repoRoot, original)), normalize(join(repoRoot, wrapper))]),
);

export async function resolve(specifier, context, nextResolve) {
	if (context.parentURL?.startsWith("file://")) {
		const parentPath = fileURLToPath(context.parentURL);
		if (exemptPrefixes.some((prefix) => parentPath.startsWith(prefix))) {
			return nextResolve(specifier, context);
		}
	}
	const resolved = await nextResolve(specifier, context);
	if (resolved.url?.startsWith("file://")) {
		const redirected = redirectByFile.get(normalize(fileURLToPath(resolved.url)));
		if (redirected) {
			return {
				url: pathToFileURL(redirected).href,
				shortCircuit: true,
			};
		}
	}
	return resolved;
}
