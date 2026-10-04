/**
 * Tests for the shared layered settings.json storage
 * (plus/src/coding-agent/core/settings-layers.ts): the layer stack
 * ~/.pi < base agent < agent dir < project (the base layer only exists under a
 * hub profile, marked by PI_PLUS_BASE_AGENT_DIR), readLayeredSetting takes the
 * highest-precedence layer whose value validates, and writeLayeredSetting
 * persists general keys to the base layer under a profile (with the profile
 * shadow dropped) or to the agent dir otherwise.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let fakeHome: string;

// Isolate from the real home directory: the lowest layer is ~/.pi/settings.json.
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: () => fakeHome };
});

const { getSettingsLayerPaths, readLayeredSetting, writeLayeredSetting } = await import(
	"../../src/coding-agent/core/settings-layers.ts"
);

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const ENV_BASE_AGENT_DIR = "PI_PLUS_BASE_AGENT_DIR";

interface Fixture {
	cwd: string;
	root: string;
	agentDir: string;
}

function fixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plus-settings-layers-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fakeHome = path.join(root, "home");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(path.join(fakeHome, ".pi"), { recursive: true });
	return { cwd, root, agentDir };
}

let current: Fixture | undefined;

function writeSettings(dir: string, contents: unknown): void {
	fs.writeFileSync(
		path.join(dir, "settings.json"),
		typeof contents === "string" ? contents : JSON.stringify(contents),
	);
}

function readJson(file: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

const asBoolean = (value: unknown) => (typeof value === "boolean" ? value : undefined);

afterEach(() => {
	delete process.env[ENV_AGENT_DIR];
	delete process.env[ENV_BASE_AGENT_DIR];
	if (current) {
		fs.rmSync(current.root, { recursive: true, force: true });
		current = undefined;
	}
});

describe("getSettingsLayerPaths", () => {
	it("without a profile: ~/.pi, agent dir, project (increasing precedence)", () => {
		current = fixture();
		process.env[ENV_AGENT_DIR] = current.agentDir;
		expect(getSettingsLayerPaths(current.cwd)).toEqual([
			path.join(fakeHome, ".pi", "settings.json"),
			path.join(current.agentDir, "settings.json"),
			path.join(current.cwd, ".pi", "settings.json"),
		]);
	});

	it("under a hub profile: the base agent layer sits between ~/.pi and the agent dir", () => {
		current = fixture();
		const baseDir = path.join(current.root, "base-agent");
		fs.mkdirSync(baseDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = current.agentDir;
		process.env[ENV_BASE_AGENT_DIR] = baseDir;
		expect(getSettingsLayerPaths(current.cwd)).toEqual([
			path.join(fakeHome, ".pi", "settings.json"),
			path.join(baseDir, "settings.json"),
			path.join(current.agentDir, "settings.json"),
			path.join(current.cwd, ".pi", "settings.json"),
		]);
	});
});

describe("readLayeredSetting", () => {
	it("returns undefined when no layer has a valid value", () => {
		current = fixture();
		process.env[ENV_AGENT_DIR] = current.agentDir;
		expect(readLayeredSetting(current.cwd, "flag", asBoolean)).toBeUndefined();
	});

	it("takes the highest-precedence layer first (project beats agent dir beats ~/.pi)", () => {
		current = fixture();
		process.env[ENV_AGENT_DIR] = current.agentDir;
		writeSettings(path.join(fakeHome, ".pi"), { flag: true });
		writeSettings(current.agentDir, { flag: false });
		writeSettings(path.join(current.cwd, ".pi"), { flag: true });
		expect(readLayeredSetting(current.cwd, "flag", asBoolean)).toBe(true);
	});

	it("a false value is a hit, not a miss", () => {
		current = fixture();
		process.env[ENV_AGENT_DIR] = current.agentDir;
		writeSettings(current.agentDir, { flag: false });
		writeSettings(path.join(fakeHome, ".pi"), { flag: true });
		expect(readLayeredSetting(current.cwd, "flag", asBoolean)).toBe(false);
	});

	it("invalid values and unreadable files fall through to the next layer", () => {
		current = fixture();
		process.env[ENV_AGENT_DIR] = current.agentDir;
		writeSettings(path.join(current.cwd, ".pi"), { flag: "yes" });
		writeSettings(current.agentDir, "{ not json");
		writeSettings(path.join(fakeHome, ".pi"), { flag: true });
		expect(readLayeredSetting(current.cwd, "flag", asBoolean)).toBe(true);
	});

	it("reads the base agent layer under a hub profile when the profile copy lacks the key", () => {
		current = fixture();
		const baseDir = path.join(current.root, "base-agent");
		fs.mkdirSync(baseDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = current.agentDir;
		process.env[ENV_BASE_AGENT_DIR] = baseDir;
		writeSettings(baseDir, { flag: true });
		expect(readLayeredSetting(current.cwd, "flag", asBoolean)).toBe(true);
	});
});

describe("writeLayeredSetting", () => {
	it("without a profile writes the agent dir file, preserving other keys", () => {
		current = fixture();
		process.env[ENV_AGENT_DIR] = current.agentDir;
		writeSettings(current.agentDir, { theme: "dark" });
		expect(writeLayeredSetting("flag", true)).toBe(true);
		const raw = readJson(path.join(current.agentDir, "settings.json"));
		expect(raw.flag).toBe(true);
		expect(raw.theme).toBe("dark");
		expect(readLayeredSetting(current.cwd, "flag", asBoolean)).toBe(true);
	});

	it("creates the settings file when missing", () => {
		current = fixture();
		process.env[ENV_AGENT_DIR] = current.agentDir;
		expect(writeLayeredSetting("flag", false)).toBe(true);
		expect(fs.existsSync(path.join(current.agentDir, "settings.json"))).toBe(true);
	});

	it("under a hub profile writes the base layer and drops a stale profile shadow", () => {
		current = fixture();
		const baseDir = path.join(current.root, "base-agent");
		fs.mkdirSync(baseDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = current.agentDir;
		process.env[ENV_BASE_AGENT_DIR] = baseDir;
		writeSettings(current.agentDir, { flag: false, defaultModel: "kimi" });
		writeSettings(baseDir, { theme: "dark" });
		expect(writeLayeredSetting("flag", true)).toBe(true);
		expect(readJson(path.join(baseDir, "settings.json")).flag).toBe(true);
		expect(readJson(path.join(baseDir, "settings.json")).theme).toBe("dark");
		const profile = readJson(path.join(current.agentDir, "settings.json"));
		expect("flag" in profile).toBe(false);
		expect(profile.defaultModel).toBe("kimi");
		expect(readLayeredSetting(current.cwd, "flag", asBoolean)).toBe(true);
	});
});
