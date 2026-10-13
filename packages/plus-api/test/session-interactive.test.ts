/**
 * The SDK entry points declare whether their host counts as user history, which
 * lands in the transcript header's `interactive` flag. History surfaces (the Pi+
 * desktop sidebar) hide `interactive === false`; a scripted embed without dialog
 * handlers must not pollute a user's session list, and a UI host must not vanish
 * from it.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPlusAgentSessionRuntime, type PlusUIDialogHandlers, setDefaultSessionInteractive } from "../src/api.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-plus-interactive-"));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	setDefaultSessionInteractive(true);
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const dialogHandlers = { confirm: async () => true } as unknown as PlusUIDialogHandlers;

/** Create a runtime whose session is persisted under a temp agent dir and return
 *  the header flag, checking that the in-memory header matches what reaches disk. */
async function headerFlagFor(options: {
	ui?: PlusUIDialogHandlers;
	interactive?: boolean;
}): Promise<boolean | undefined> {
	const cwd = makeTempDir();
	const agentDir = makeTempDir();
	const runtime = await createPlusAgentSessionRuntime({ cwd, agentDir, ...options });
	try {
		const manager = runtime.session.sessionManager;
		const header = manager.getHeader();
		expect(header?.interactive).toBeDefined();
		const file = manager.getSessionFile();
		expect(file).toBeTruthy();
		manager.appendMessage({ role: "user", content: "touch", timestamp: Date.now() } as never);
		const persisted = JSON.parse(readFileSync(file!, "utf8").split("\n")[0]) as { interactive?: boolean };
		expect(persisted.interactive).toBe(header!.interactive);
		return header!.interactive;
	} finally {
		await runtime.dispose();
	}
}

describe("createPlusAgentSessionRuntime interactive flag", () => {
	it("treats a UI host (dialog handlers installed) as user history", async () => {
		expect(await headerFlagFor({ ui: dialogHandlers })).toBe(true);
	});

	it("treats a bare programmatic embed as headless", async () => {
		expect(await headerFlagFor({})).toBe(false);
	});

	it("honours an explicit interactive: false even with dialog handlers", async () => {
		expect(await headerFlagFor({ ui: dialogHandlers, interactive: false })).toBe(false);
	});

	it("honours an explicit interactive: true without dialog handlers", async () => {
		expect(await headerFlagFor({ interactive: true })).toBe(true);
	});
});
