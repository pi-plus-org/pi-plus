/**
 * Tests for the provider-request-timeout / HTTP-dispatcher patches in
 * plus/src/coding-agent/core/settings-manager.ts: the LLM request ceiling gets
 * its own default (10 minutes floor, never below the configured socket idle
 * timeout, no ceiling when the idle timeout is disabled) instead of inheriting
 * httpIdleTimeoutMs, an explicit retry.provider.timeoutMs still wins, the
 * OpenAI client's "Request timed out." deadline error classifies as retryable so
 * the extra attempts actually happen, and the profile-owned dispatcher is armed by SettingsManager.create so embedded hosts
 * honor httpIdleTimeoutMs too.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { isRetryableAssistantError } from "../../../ai/src/utils/retry.ts";
import { SettingsManager } from "../../src/coding-agent/core/settings-manager.ts";

const MIN_REQUEST_CEILING_MS = 600_000;
const NO_CEILING_MS = 2_147_483_647;

const createdDirs: string[] = [];

function managerWith(settings: Record<string, unknown>): SettingsManager {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plus-request-timeout-"));
	createdDirs.push(root);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
	return SettingsManager.create(cwd, agentDir);
}

afterEach(() => {
	for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("provider request ceiling is separate from the socket idle timeout", () => {
	it("raises the default 300s idle timeout to the 10 minute request floor", () => {
		const mgr = managerWith({});
		expect(mgr.getHttpIdleTimeoutMs()).toBe(300_000);
		expect(mgr.getProviderRetrySettings().timeoutMs).toBe(MIN_REQUEST_CEILING_MS);
	});

	it("keeps every other provider retry default", () => {
		const mgr = managerWith({ retry: { provider: { maxRetries: 5 } } });
		const settings = mgr.getProviderRetrySettings();
		expect(settings.timeoutMs).toBe(MIN_REQUEST_CEILING_MS);
		expect(settings.maxRetries).toBe(5);
		expect(settings.maxRetryDelayMs).toBe(60_000);
	});

	it("honors an explicit retry.provider.timeoutMs, even below the floor", () => {
		const mgr = managerWith({ retry: { provider: { timeoutMs: 45_000 } } });
		expect(mgr.getProviderRetrySettings().timeoutMs).toBe(45_000);
	});

	it("never goes below a longer configured idle timeout", () => {
		const mgr = managerWith({ httpIdleTimeoutMs: 900_000 });
		expect(mgr.getHttpIdleTimeoutMs()).toBe(900_000);
		expect(mgr.getProviderRetrySettings().timeoutMs).toBe(900_000);
	});

	it("drops the ceiling entirely when the idle timeout is disabled", () => {
		const mgr = managerWith({ httpIdleTimeoutMs: "disabled" });
		expect(mgr.getHttpIdleTimeoutMs()).toBe(0);
		expect(mgr.getProviderRetrySettings().timeoutMs).toBe(NO_CEILING_MS);
	});
});

describe("the request-timeout error is retryable", () => {
	// The raised ceiling only helps if the deadline error flows through the retry
	// policy instead of ending the turn (this is the exact transcript error text).
	it('retries "Request timed out."', () => {
		expect(
			isRetryableAssistantError({
				role: "assistant",
				stopReason: "error",
				errorMessage: "Request timed out.",
				content: [],
			} as never),
		).toBe(true);
	});
});

describe("profile owns the process HTTP dispatcher", () => {
	it("arms the dispatcher when a settings manager is created", () => {
		const before = getGlobalDispatcher();
		const mgr = managerWith({ httpIdleTimeoutMs: 60_000 });
		// Upstream only installs this from its CLI entry points; create() is the
		// one factory every host uses, so an embedder gets the same behavior.
		expect(mgr.getHttpIdleTimeoutMs()).toBe(60_000);
		expect(getGlobalDispatcher()).not.toBe(before);
	});
});
