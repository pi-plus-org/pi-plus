/**
 * Tests for plus/src/extensions/subagent/run.ts — CLI invocation candidate
 * selection and child argument construction. The Electron guard matters for
 * embedded hosts (the Pi+ desktop app): process.execPath there is the host
 * GUI binary, so a self-spawn candidate would relaunch the app instead of
 * running a pi child process.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { afterEach, describe, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../coding-agent/src/config.ts";
import type { AgentConfig } from "../../src/extensions/subagent/agents.ts";
import { buildSubagentArgs, getPiInvocationCandidates } from "../../src/extensions/subagent/run.ts";

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

const workerAgent: AgentConfig = {
	name: "worker",
	description: "",
	systemPrompt: "",
	source: "builtin",
	filePath: "",
};

describe("buildSubagentArgs", () => {
	const originalHubDir = process.env.PI_HUB_DIR;
	const originalAgentDirEnv = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (originalHubDir === undefined) delete process.env.PI_HUB_DIR;
		else process.env.PI_HUB_DIR = originalHubDir;
		if (originalAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDirEnv;
	});

	it("pins the parent's hub profile with --as when the session agent dir is a profile dir", () => {
		process.env.PI_HUB_DIR = "/tmp/pi-subagent-test-hub";
		const args = buildSubagentArgs(
			{ agentDir: "/tmp/pi-subagent-test-hub/profiles/qwen", model: "p/m" },
			workerAgent,
		);
		// A child without the pin would re-resolve the stored default profile
		// and run this model against that profile's endpoint.
		assert.deepEqual(args, [
			"--as",
			"qwen",
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"p/m",
			"--exclude-tools",
			"subagent",
		]);
	});

	it("falls back to PI_CODING_AGENT_DIR when no agentDir is bound (pipi CLI hosts)", () => {
		process.env.PI_HUB_DIR = "/tmp/pi-subagent-test-hub";
		process.env[ENV_AGENT_DIR] = "/tmp/pi-subagent-test-hub/profiles/cit-llm";
		const args = buildSubagentArgs({}, workerAgent);
		assert.deepEqual(args.slice(0, 2), ["--as", "cit-llm"]);
	});

	it("omits --as for non-profile agent dirs", () => {
		process.env.PI_HUB_DIR = "/tmp/pi-subagent-test-hub";
		const args = buildSubagentArgs({ agentDir: "/tmp/pi-subagent-test-hub/agent" }, workerAgent);
		assert.ok(!args.includes("--as"));
		assert.deepEqual(args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
	});
});
