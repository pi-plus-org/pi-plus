/**
 * Tests for the skill-block display sanitizer
 * (plus/src/coding-agent/core/skill-block.ts) and its wiring into the
 * SessionManager list/listAll decoration: a session whose first message is a
 * skill invocation lists with the user's own text (or the skill names) as
 * firstMessage instead of the expanded `<skill ...>` definition.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/coding-agent/core/session-manager.ts";
import { stripLeadingSkillBlocks } from "../../src/coding-agent/core/skill-block.ts";

const SKILL_BLOCK =
	'<skill name="cp-dlc" location="/skills/cp-dlc/SKILL.md">\nReferences are relative to /skills/cp-dlc.\n\n# cp-dlc\n\nBody text.\n</skill>';

describe("stripLeadingSkillBlocks", () => {
	it("returns messages without a leading block unchanged", () => {
		expect(stripLeadingSkillBlocks("hello world")).toBe("hello world");
		expect(stripLeadingSkillBlocks("  padded  ")).toBe("  padded  ");
		expect(stripLeadingSkillBlocks(`text before ${SKILL_BLOCK}`)).toBe(`text before ${SKILL_BLOCK}`);
		expect(stripLeadingSkillBlocks("")).toBe("");
	});

	it("replaces a pure invocation with the skill name", () => {
		expect(stripLeadingSkillBlocks(SKILL_BLOCK)).toBe("/skill:cp-dlc");
		expect(stripLeadingSkillBlocks(`${SKILL_BLOCK}\n`)).toBe("/skill:cp-dlc");
	});

	it("keeps the user's text after the block", () => {
		expect(stripLeadingSkillBlocks(`${SKILL_BLOCK}\n\ncompare the tables`)).toBe("compare the tables");
	});

	it("strips stacked invocations", () => {
		const second = '<skill name="tdlc" location="/skills/tdlc/SKILL.md">\nBody.\n</skill>';
		expect(stripLeadingSkillBlocks(`${SKILL_BLOCK}\n${second}\n\nrun it`)).toBe("run it");
		expect(stripLeadingSkillBlocks(`${SKILL_BLOCK}\n${second}`)).toBe("/skill:cp-dlc /skill:tdlc");
	});
});

describe("SessionManager list firstMessage sanitizing", () => {
	let root: string;

	afterEach(() => {
		if (root) fs.rmSync(root, { recursive: true, force: true });
	});

	it("lists skill-first sessions with the user's text, not the skill definition", async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plus-skill-block-"));
		const sessionDir = path.join(root, "sessions");
		const manager = SessionManager.create(root, sessionDir);
		manager.appendMessage({
			role: "user" as const,
			content: [{ type: "text" as const, text: `${SKILL_BLOCK}\n\ncompare the tables` }],
			timestamp: Date.now(),
		});

		const listed = await SessionManager.list(root, sessionDir);
		expect(listed).toHaveLength(1);
		expect(listed[0].firstMessage).toBe("compare the tables");
		// Search text stays raw so skill content still matches.
		expect(listed[0].allMessagesText).toContain("<skill name=");

		const all = await SessionManager.listAll(sessionDir);
		expect(all[0].firstMessage).toBe("compare the tables");
	});
});
