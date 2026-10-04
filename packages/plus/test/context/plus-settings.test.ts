/**
 * Tests for plus/src/context/plus-settings.ts — the pi-plus settings store
 * (the `piPlus` block of the agent settings.json) backing the /settings
 * "Auto-compact threshold" row and host-owned embedding keys.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
	DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
	DEFAULT_CONTEXT_FLOOR_TOKENS,
	formatAutoCompactThresholdPercent,
	formatContextFloorTokens,
	formatContextWindowCapTokens,
	getAutoCompactThresholdPercent,
	getContextFloorTokens,
	getContextWindowCapTokens,
	MIN_CONTEXT_FLOOR_TOKENS,
	MIN_CONTEXT_WINDOW_CAP_TOKENS,
	parseAutoCompactThresholdChoice,
	parseContextFloorChoice,
	parseContextWindowCapChoice,
	readPiPlusSettings,
	setAutoCompactThresholdPercent,
	setContextFloorTokens,
	setContextWindowCapTokens,
	updatePiPlusSettings,
} from "../../src/context/plus-settings.ts";

let dir: string;
let settingsFile: string;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedBaseAgentDir = process.env.PI_PLUS_BASE_AGENT_DIR;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plus-settings-"));
	settingsFile = join(dir, "settings.json");
	// The store resolves through the agent dir (base layer under a profile);
	// a plain temp dir exercises the no-profile path.
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.PI_PLUS_BASE_AGENT_DIR;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	if (savedBaseAgentDir === undefined) delete process.env.PI_PLUS_BASE_AGENT_DIR;
	else process.env.PI_PLUS_BASE_AGENT_DIR = savedBaseAgentDir;
});

function writeBlock(block: Record<string, unknown>, document: Record<string, unknown> = {}): void {
	writeFileSync(settingsFile, JSON.stringify({ ...document, piPlus: block }));
}

describe("readPiPlusSettings", () => {
	it("returns {} when the file does not exist; the effective percent is the 80% default", () => {
		assert.deepEqual(readPiPlusSettings(), {});
		assert.equal(getAutoCompactThresholdPercent(), DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT);
	});

	it("returns {} for malformed JSON and non-object shapes", () => {
		writeFileSync(settingsFile, "not json {");
		assert.deepEqual(readPiPlusSettings(), {});
		writeFileSync(settingsFile, "[1, 2]");
		assert.deepEqual(readPiPlusSettings(), {});
		writeFileSync(settingsFile, JSON.stringify({ piPlus: "nope" }));
		assert.deepEqual(readPiPlusSettings(), {});
	});

	it("passes host-owned keys through raw", () => {
		writeBlock({ desktopTheme: "dark", sidebarWidth: 300 });
		assert.deepEqual(readPiPlusSettings(), { desktopTheme: "dark", sidebarWidth: 300 });
	});
});

describe("typed getters read the piPlus block", () => {
	it("ignores out-of-range or non-numeric percent values", () => {
		for (const bad of [0, -5, 100.5, NaN, "95", null]) {
			writeBlock({ autoCompactThresholdPercent: bad });
			assert.equal(
				getAutoCompactThresholdPercent(),
				DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
				`value: ${String(bad)}`,
			);
		}
	});

	it("accepts a valid percent", () => {
		writeBlock({ autoCompactThresholdPercent: 95 });
		assert.equal(getAutoCompactThresholdPercent(), 95);
	});

	it("ignores out-of-range or non-integer context floor values", () => {
		for (const bad of [0, 12_999, 13_000.5, NaN, "32768", null]) {
			writeBlock({ contextFloorTokens: bad });
			assert.equal(getContextFloorTokens(), DEFAULT_CONTEXT_FLOOR_TOKENS, `value: ${String(bad)}`);
		}
	});

	it("accepts a valid context floor", () => {
		writeBlock({ autoCompactThresholdPercent: 85, contextFloorTokens: 32_768 });
		assert.equal(getAutoCompactThresholdPercent(), 85);
		assert.equal(getContextFloorTokens(), 32_768);
	});

	it("ignores out-of-range or non-integer context window cap values", () => {
		for (const bad of [0, 32_767, 32_768.5, NaN, "262144", null]) {
			writeBlock({ contextWindowCapTokens: bad });
			assert.equal(getContextWindowCapTokens(), undefined, `value: ${String(bad)}`);
		}
	});

	it("accepts a valid context window cap", () => {
		writeBlock({ autoCompactThresholdPercent: 85, contextFloorTokens: 32_768, contextWindowCapTokens: 262_144 });
		assert.equal(getContextWindowCapTokens(), 262_144);
	});
});

describe("setAutoCompactThresholdPercent", () => {
	it("round-trips through the block", () => {
		setAutoCompactThresholdPercent(90);
		assert.equal(getAutoCompactThresholdPercent(), 90);
		assert.deepEqual(readPiPlusSettings(), { autoCompactThresholdPercent: 90 });
	});

	it("resetting to undefined restores the 80% default", () => {
		setAutoCompactThresholdPercent(90);
		setAutoCompactThresholdPercent(undefined);
		assert.equal(getAutoCompactThresholdPercent(), DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT);
		assert.deepEqual(readPiPlusSettings(), {});
	});

	it("rejects invalid percents", () => {
		for (const bad of [0, 101, NaN]) {
			assert.throws(() => setAutoCompactThresholdPercent(bad), /Invalid auto-compact threshold/);
		}
	});

	it("preserves unrelated settings.json content (upstream and unknown keys)", () => {
		writeBlock(
			{ autoCompactThresholdPercent: 85, desktopTheme: "light" },
			{ theme: "dark", compaction: { enabled: true }, hooks: { Stop: [] }, someUnknownKey: 42 },
		);
		setAutoCompactThresholdPercent(95);
		const raw: Record<string, unknown> = JSON.parse(readFileSync(settingsFile, "utf8"));
		assert.deepEqual(raw, {
			theme: "dark",
			compaction: { enabled: true },
			hooks: { Stop: [] },
			someUnknownKey: 42,
			piPlus: { autoCompactThresholdPercent: 95, desktopTheme: "light" },
		});
	});
});

describe("setContextFloorTokens", () => {
	it("round-trips through the block", () => {
		setContextFloorTokens(32_768);
		assert.equal(getContextFloorTokens(), 32_768);
		assert.deepEqual(readPiPlusSettings(), { contextFloorTokens: 32_768 });
	});

	it("resetting to undefined restores the 13k default", () => {
		setContextFloorTokens(32_768);
		setContextFloorTokens(undefined);
		assert.equal(getContextFloorTokens(), DEFAULT_CONTEXT_FLOOR_TOKENS);
		assert.deepEqual(readPiPlusSettings(), {});
	});

	it("rejects floors below the built-in 13k minimum and non-integers", () => {
		for (const bad of [0, 12_999, 13_000.5, NaN]) {
			assert.throws(() => setContextFloorTokens(bad), /Invalid context floor tokens/);
		}
	});

	it("preserves the threshold key in the block", () => {
		writeBlock({ autoCompactThresholdPercent: 85 });
		setContextFloorTokens(65_536);
		assert.deepEqual(readPiPlusSettings(), { autoCompactThresholdPercent: 85, contextFloorTokens: 65_536 });
	});
});

describe("setContextWindowCapTokens", () => {
	it("round-trips through the block", () => {
		setContextWindowCapTokens(262_144);
		assert.equal(getContextWindowCapTokens(), 262_144);
		assert.deepEqual(readPiPlusSettings(), { contextWindowCapTokens: 262_144 });
	});

	it("defaults to undefined (no cap) and resets to it", () => {
		assert.equal(getContextWindowCapTokens(), undefined);
		setContextWindowCapTokens(262_144);
		setContextWindowCapTokens(undefined);
		assert.equal(getContextWindowCapTokens(), undefined);
		assert.deepEqual(readPiPlusSettings(), {});
	});

	it("rejects caps below the 32k minimum and non-integers", () => {
		for (const bad of [0, 32_767, 32_768.5, NaN]) {
			assert.throws(() => setContextWindowCapTokens(bad), /Invalid context window cap tokens/);
		}
	});
});

describe("updatePiPlusSettings (host-owned keys)", () => {
	it("merges, deletes undefined keys, and creates the block lazily", () => {
		updatePiPlusSettings({ desktopTheme: "dark", sidebarWidth: 300 });
		assert.deepEqual(readPiPlusSettings(), { desktopTheme: "dark", sidebarWidth: 300 });
		updatePiPlusSettings({ desktopTheme: undefined });
		assert.deepEqual(readPiPlusSettings(), { sidebarWidth: 300 });
		updatePiPlusSettings({ sidebarWidth: undefined });
		// Empty block: the piPlus key itself disappears from the document.
		const raw: Record<string, unknown> = JSON.parse(readFileSync(settingsFile, "utf8"));
		assert.equal("piPlus" in raw, false);
	});
});

describe("base-layer resolution under a hub profile", () => {
	it("reads the base agent file and ignores a stale piPlus copy in the profile dir", () => {
		const baseDir = dir;
		const profileDir = join(dir, "profile");
		mkdirSync(profileDir);
		writeFileSync(join(baseDir, "settings.json"), JSON.stringify({ piPlus: { autoCompactThresholdPercent: 95 } }));
		// Materialized profile copies carry a stale shadow; it must not win.
		writeFileSync(join(profileDir, "settings.json"), JSON.stringify({ piPlus: { autoCompactThresholdPercent: 60 } }));
		process.env.PI_CODING_AGENT_DIR = profileDir;
		process.env.PI_PLUS_BASE_AGENT_DIR = baseDir;
		assert.equal(getAutoCompactThresholdPercent(), 95);
		setAutoCompactThresholdPercent(85);
		// Writes land in the base file, not the profile copy.
		const profileRaw: Record<string, unknown> = JSON.parse(readFileSync(join(profileDir, "settings.json"), "utf8"));
		assert.deepEqual(profileRaw, { piPlus: { autoCompactThresholdPercent: 60 } });
		assert.equal(getAutoCompactThresholdPercent(), 85);
	});
});

describe("context window cap choice parsing", () => {
	it("round-trips labels", () => {
		assert.equal(formatContextWindowCapTokens(262_144), "262144");
		assert.equal(parseContextWindowCapChoice("262144"), 262_144);
	});

	it("maps every UI choice through parse+format unchanged", () => {
		for (const choice of ["131072", "262144", "524288", "1048576"]) {
			assert.equal(formatContextWindowCapTokens(parseContextWindowCapChoice(choice)), choice);
		}
	});

	it("parses 'No cap' to undefined", () => {
		assert.equal(parseContextWindowCapChoice("No cap"), undefined);
		assert.equal(parseContextWindowCapChoice("no cap"), undefined);
		assert.equal(formatContextWindowCapTokens(undefined), "No cap");
	});

	it("accepts a k suffix as Ki tokens", () => {
		assert.equal(parseContextWindowCapChoice("256k"), 262_144);
		assert.equal(parseContextWindowCapChoice("512K"), 524_288);
	});

	it("rejects unparseable or below-minimum input", () => {
		assert.equal(parseContextWindowCapChoice("auto"), undefined);
		assert.equal(parseContextWindowCapChoice("16k"), undefined);
		assert.equal(parseContextWindowCapChoice("garbage"), undefined);
	});

	it("minimum accepted cap is 32k", () => {
		assert.equal(MIN_CONTEXT_WINDOW_CAP_TOKENS, 32_768);
	});
});

describe("context floor choice parsing", () => {
	it("round-trips labels", () => {
		assert.equal(formatContextFloorTokens(13_000), "13000");
		assert.equal(parseContextFloorChoice("32768"), 32_768);
	});

	it("accepts a k suffix as Ki tokens", () => {
		assert.equal(parseContextFloorChoice("32k"), 32_768);
		assert.equal(parseContextFloorChoice("32K"), 32_768);
	});

	it("maps every UI choice through parse+format unchanged", () => {
		for (const choice of ["13000", "16384", "24576", "32768", "65536"]) {
			assert.equal(formatContextFloorTokens(parseContextFloorChoice(choice)), choice);
		}
	});

	it("falls back to the default for unparseable or below-minimum input", () => {
		assert.equal(parseContextFloorChoice("auto"), DEFAULT_CONTEXT_FLOOR_TOKENS);
		assert.equal(parseContextFloorChoice("10k"), DEFAULT_CONTEXT_FLOOR_TOKENS);
		assert.equal(parseContextFloorChoice(""), DEFAULT_CONTEXT_FLOOR_TOKENS);
	});

	it("minimum accepted floor equals the built-in 13k buffer", () => {
		assert.equal(MIN_CONTEXT_FLOOR_TOKENS, DEFAULT_CONTEXT_FLOOR_TOKENS);
	});
});

describe("choice label parsing", () => {
	it("round-trips labels", () => {
		assert.equal(formatAutoCompactThresholdPercent(80), "80%");
		assert.equal(parseAutoCompactThresholdChoice("70%"), 70);
	});

	it("maps every UI choice through parse+format unchanged", () => {
		for (const choice of ["70%", "80%", "85%", "90%", "95%"]) {
			assert.equal(formatAutoCompactThresholdPercent(parseAutoCompactThresholdChoice(choice)), choice);
		}
	});

	it("falls back to the default for unparseable input", () => {
		assert.equal(parseAutoCompactThresholdChoice("auto"), DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT);
		assert.equal(parseAutoCompactThresholdChoice("garbage"), DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT);
	});
});
