/**
 * Tests for plus/src/extensions/subagent/run.ts — CLI invocation candidate
 * selection. The Electron guard matters for embedded hosts (the Pi+ desktop
 * app): process.execPath there is the host GUI binary, so a self-spawn
 * candidate would relaunch the app instead of running a pi child process.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, describe, it } from "vitest";
import { getPiInvocationCandidates } from "../../src/extensions/subagent/run.ts";

const versions = process.versions as Record<string, string | undefined>;
const originalElectron = versions.electron;

afterEach(() => {
	if (originalElectron === undefined) delete versions.electron;
	else versions.electron = originalElectron;
});

describe("getPiInvocationCandidates", () => {
	it("offers only the pipi/pi PATH fallbacks under an Electron host", () => {
		versions.electron = "99.0.0";
		const candidates = getPiInvocationCandidates(["--mode", "json", "Task: x"]);
		assert.deepEqual(
			candidates.map((c) => c.command),
			["pipi", "pi"],
		);
		assert.ok(candidates.every((c) => !c.args.includes(process.argv[1] ?? "\0")));
	});

	it("offers the current-script self-spawn first under a plain node host", () => {
		delete versions.electron;
		const candidates = getPiInvocationCandidates(["--mode", "json"]);
		// vitest's argv[1] is a real script file, so the self-spawn branch is
		// taken; the bare-execPath branch is not (execPath is named "node").
		if (fs.existsSync(process.argv[1] ?? "")) {
			assert.equal(candidates[0].command, process.execPath);
			assert.equal(candidates[0].args[0], process.argv[1]);
			assert.deepEqual(candidates[0].args.slice(1), ["--mode", "json"]);
		} else {
			assert.equal(candidates[0].command, "pipi");
		}
		assert.deepEqual(
			candidates.slice(-2).map((c) => c.command),
			["pipi", "pi"],
		);
	});
});
