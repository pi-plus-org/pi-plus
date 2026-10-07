/**
 * Tests for plus/src/coding-agent/core/agent-session.ts —
 * applyWindowsShellFallback. On Windows without any bash (no Git Bash, none on
 * PATH) and no user-configured shellPath, the built-in "bash" tool can never
 * succeed; the fallback excludes it and swaps "powershell" into the active
 * toolset. process.platform is stubbed to exercise the Windows branch on any
 * host — getShellConfig's win32 path then searches Git Bash locations that
 * don't exist here and `where bash.exe` fails, so the "no bash" throw is real.
 */

import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionConfig } from "../../src/coding-agent/core/agent-session.ts";
import { applyWindowsShellFallback } from "../../src/coding-agent/core/agent-session.ts";

const REAL_PLATFORM = process.platform;

function stubPlatform(platform: string): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function fakeConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
	return {
		settingsManager: { getShellPath: () => undefined },
		...overrides,
	} as unknown as AgentSessionConfig;
}

afterEach(() => {
	stubPlatform(REAL_PLATFORM);
	vi.restoreAllMocks();
});

describe("applyWindowsShellFallback", () => {
	it("leaves the config untouched on non-Windows", () => {
		stubPlatform("darwin");
		const config = fakeConfig();
		assert.equal(applyWindowsShellFallback(config), config);
	});

	it("excludes bash and activates powershell on Windows without bash", () => {
		stubPlatform("win32");
		const result = applyWindowsShellFallback(fakeConfig());
		expect(result.excludedToolNames).toContain("bash");
		expect(result.initialActiveToolNames).toContain("powershell");
		expect(result.initialActiveToolNames).not.toContain("bash");
	});

	it("preserves the remaining default active tools when swapping bash", () => {
		stubPlatform("win32");
		const result = applyWindowsShellFallback(fakeConfig());
		expect(result.initialActiveToolNames).toEqual(["read", "powershell", "edit", "write"]);
	});

	it("swaps bash inside an explicit initialActiveToolNames list", () => {
		stubPlatform("win32");
		const result = applyWindowsShellFallback(fakeConfig({ initialActiveToolNames: ["read", "bash", "custom"] }));
		expect(result.initialActiveToolNames).toEqual(["read", "powershell", "custom"]);
	});

	it("appends to an existing excludedToolNames list without duplicates", () => {
		stubPlatform("win32");
		const result = applyWindowsShellFallback(fakeConfig({ excludedToolNames: ["vim"] }));
		expect(result.excludedToolNames).toEqual(["vim", "bash"]);
		const again = applyWindowsShellFallback(result);
		expect(again.excludedToolNames).toEqual(["vim", "bash"]);
	});

	it("respects a user-configured shellPath", () => {
		stubPlatform("win32");
		const config = fakeConfig({
			settingsManager: { getShellPath: () => "C:\\tools\\bash.exe" },
		} as Partial<AgentSessionConfig>);
		assert.equal(applyWindowsShellFallback(config), config);
	});
});
