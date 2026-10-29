/**
 * Tests for the provider-request-timeout patches: the LLM request ceiling gets
 * its own default (10 minutes floor, never below the configured socket idle
 * timeout, no ceiling when the idle timeout is disabled) instead of inheriting
 * httpIdleTimeoutMs (settings-manager wrapper), an explicit
 * retry.provider.timeoutMs still wins, the timeout errors classify as retryable
 * so the extra attempts actually happen, the socket's response-headers budget is
 * armed above the configured between-bytes idle timeout (http-dispatcher
 * wrapper), and that dispatcher is armed by SettingsManager.create so embedded
 * hosts honor the profile's setting at all.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { isRetryableAssistantError } from "../../../ai/src/utils/retry.ts";
import {
	PI_PLUS_HEADERS_TIMEOUT_GRACE_MS,
	PI_PLUS_MIN_PROVIDER_REQUEST_TIMEOUT_MS,
	PI_PLUS_NO_TIMEOUT_MS,
	plusDispatcherTimeoutMs,
} from "../../src/coding-agent/core/http-dispatcher.ts";
import { SettingsManager } from "../../src/coding-agent/core/settings-manager.ts";

const MIN_REQUEST_CEILING_MS = PI_PLUS_MIN_PROVIDER_REQUEST_TIMEOUT_MS;

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

function errorText(errorMessage: string): never {
	return { role: "assistant", stopReason: "error", errorMessage, content: [] } as never;
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
		expect(mgr.getProviderRetrySettings().timeoutMs).toBe(PI_PLUS_NO_TIMEOUT_MS);
	});
});

describe("the timeout errors are retryable", () => {
	// The raised ceilings only help if the deadline errors flow through the retry
	// policy instead of ending the turn; these are the transcript texts.
	it('retries "Request timed out." (OpenAI client deadline)', () => {
		expect(isRetryableAssistantError(errorText("Request timed out."))).toBe(true);
	});

	it('retries the undici headers-timeout wording ("...waiting for response headers")', () => {
		expect(
			isRetryableAssistantError(
				errorText(
					"Request timed out. Node.js fetch timed out waiting for response headers; configure a matching undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout.",
				),
			),
		).toBe(true);
	});
});

describe("the socket gives the response headers more than the idle timeout", () => {
	// undici's headersTimeout is a first-byte budget, not a between-bytes idle
	// guard, but upstream arms it from httpIdleTimeoutMs: a request that had not
	// started answering died at ~300s with zero tokens generated.
	it("raises the default 300s idle timeout to the request ceiling plus a grace", () => {
		expect(plusDispatcherTimeoutMs(300_000)).toBe(MIN_REQUEST_CEILING_MS + PI_PLUS_HEADERS_TIMEOUT_GRACE_MS);
	});

	it("stays above the provider request ceiling, so the SDK deadline fires first", () => {
		const mgr = managerWith({});
		expect(plusDispatcherTimeoutMs(mgr.getHttpIdleTimeoutMs())).toBeGreaterThan(
			mgr.getProviderRetrySettings().timeoutMs ?? 0,
		);
	});

	it("keeps a longer configured idle timeout in charge", () => {
		expect(plusDispatcherTimeoutMs(900_000)).toBe(900_000);
	});

	it("maps disabled to no timeout at all", () => {
		expect(plusDispatcherTimeoutMs(0)).toBe(0);
		expect(plusDispatcherTimeoutMs("disabled")).toBe(0);
	});

	it("falls back to the default for an unparseable value", () => {
		expect(plusDispatcherTimeoutMs("5 minutes")).toBe(300_000);
	});
});

describe("profile owns the process HTTP dispatcher", () => {
	it("arms the dispatcher when a settings manager is created", () => {
		// Upstream skips the install when the global dispatcher already carries
		// these exact timeouts, so a distinct value is what proves the arm: 900s
		// maps to 900s here, while every other test in this file arms 615s.
		const before = getGlobalDispatcher();
		const mgr = managerWith({ httpIdleTimeoutMs: 900_000 });
		// Upstream installs the dispatcher from its CLI entry points only; create()
		// is the one factory every host uses, so an embedder gets it too.
		expect(mgr.getHttpIdleTimeoutMs()).toBe(900_000);
		expect(plusDispatcherTimeoutMs(900_000)).toBe(900_000);
		expect(getGlobalDispatcher()).not.toBe(before);
	});
});
