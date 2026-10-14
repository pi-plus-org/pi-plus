/**
 * Tests for the session-header `interactive` marker overlay
 * (plus/src/coding-agent/core/session-manager.ts): new transcripts are stamped
 * with the process host mode (or an explicit NewSessionOptions override), the
 * stamp survives every session-creating path (start, `/new`, branch, fork), the
 * marker is persisted on the first line, and the read side reports it on
 * SessionInfo while pre-marker transcripts stay unmarked (= visible).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "../../../coding-agent/src/core/session-manager.ts";
import {
	getDefaultSessionInteractive,
	SessionManager,
	setDefaultSessionInteractive,
} from "../../src/coding-agent/core/session-manager.ts";

function tempRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-plus-session-marker-"));
}

function headerOf(file: string): { type?: string; interactive?: boolean } {
	const firstLine = fs.readFileSync(file, "utf-8").split("\n", 1)[0] ?? "";
	return JSON.parse(firstLine) as { type?: string; interactive?: boolean };
}

/** Transcripts are created on the first append, so force one before reading. */
function persist(manager: SessionManager): string {
	manager.appendMessage(makeUserMessage());
	const file = manager.getSessionFile();
	if (!file) throw new Error("expected a persisted session file");
	return file;
}

function makeUserMessage() {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text: "hello" }],
		timestamp: Date.now(),
	};
}

describe("session interactive marker", () => {
	let root: string;

	afterEach(() => {
		setDefaultSessionInteractive(true);
		if (root) fs.rmSync(root, { recursive: true, force: true });
	});

	function prepare(): string {
		root = tempRoot();
		return root;
	}

	it("defaults to interactive and follows the process-wide declaration", () => {
		const cwd = prepare();
		expect(getDefaultSessionInteractive()).toBe(true);

		const interactiveRun = SessionManager.create(cwd, path.join(cwd, "sessions"));
		expect(interactiveRun.getHeader()?.interactive).toBe(true);

		setDefaultSessionInteractive(false);
		const headlessRun = SessionManager.create(cwd, path.join(cwd, "sessions"));
		expect(headlessRun.getHeader()?.interactive).toBe(false);
	});

	it("lets an explicit NewSessionOptions override win over the default", () => {
		const cwd = prepare();
		setDefaultSessionInteractive(true);
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), { interactive: false });
		expect(manager.getHeader()?.interactive).toBe(false);
		expect(persist(manager)).toBeTruthy();
		expect(headerOf(manager.getSessionFile()!).interactive).toBe(false);
	});

	it("stamps the marker into the first line of the transcript", () => {
		const cwd = prepare();
		setDefaultSessionInteractive(false);
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const file = persist(manager);
		const header = headerOf(file);
		expect(header.type).toBe("session");
		expect(header.interactive).toBe(false);
	});

	it("carries the declaration across /new and fork/branch", () => {
		const cwd = prepare();
		setDefaultSessionInteractive(false);
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		persist(manager);

		// /new: same manager, brand-new transcript.
		manager.newSession();
		expect(manager.getHeader()?.interactive).toBe(false);
		const nextFile = persist(manager);
		expect(headerOf(nextFile).interactive).toBe(false);

		// Fork at a leaf: createBranchedSession writes the file during the call.
		const forked = SessionManager.create(cwd, sessionDir);
		persist(forked);
		const leafId = forked.getLeafId();
		expect(leafId).toBeTruthy();
		const branchFile = forked.createBranchedSession(leafId!);
		expect(branchFile).toBeTruthy();
		expect(headerOf(branchFile!).interactive).toBe(false);
		expect(forked.getHeader()?.interactive).toBe(false);
	});

	it("stamps forks created through SessionManager.forkFrom", () => {
		const cwd = prepare();
		const sessionDir = path.join(cwd, "sessions");
		setDefaultSessionInteractive(true);
		const source = SessionManager.create(cwd, sessionDir);
		const sourceFile = persist(source);

		setDefaultSessionInteractive(false);
		const forked = SessionManager.forkFrom(sourceFile, cwd, sessionDir);
		expect(forked.getHeader()?.interactive).toBe(false);
		expect(headerOf(forked.getSessionFile()!).interactive).toBe(false);

		// Explicit option still beats the process default.
		const explicit = SessionManager.forkFrom(sourceFile, cwd, sessionDir, { interactive: true });
		expect(headerOf(explicit.getSessionFile()!).interactive).toBe(true);
	});

	it("reports the marker on SessionInfo and leaves legacy transcripts unmarked", async () => {
		const cwd = prepare();
		const sessionDir = path.join(cwd, "sessions");

		setDefaultSessionInteractive(false);
		persist(SessionManager.create(cwd, sessionDir));
		setDefaultSessionInteractive(true);
		persist(SessionManager.create(cwd, sessionDir));

		// A pre-marker transcript: header without the flag, written by an older
		// build (or plain `pi`).
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(
			path.join(sessionDir, "legacy.jsonl"),
			`${JSON.stringify({ type: "session", id: "legacy", version: 3, timestamp: new Date(0).toISOString(), cwd })}\n`,
		);

		const listed = await SessionManager.list(cwd, sessionDir);
		expect(listed).toHaveLength(3);
		const byFlag = new Map<string, SessionInfo>(listed.map((info) => [info.id, info]));
		const flags = listed.map((info) => info.interactive).sort((a, b) => Number(a ?? 0) - Number(b ?? 0));
		expect(flags).toEqual([false, true, undefined]);
		expect([...byFlag.values()].some((info) => info.interactive === undefined)).toBe(true);
		// Filter predicate used by user-facing history lists.
		expect(listed.filter((info) => info.interactive !== false)).toHaveLength(2);

		const all = await SessionManager.listAll(sessionDir);
		const found = all.find((info) => info.id === listed.find((info) => info.interactive === false)!.id);
		expect(found?.interactive).toBe(false);

		const search = await SessionManager.search("hello", sessionDir);
		expect(search).toHaveLength(2);
		expect(search.every((info) => info.interactive !== undefined)).toBe(true);
	});

	it("deleteSession removes transcripts, tolerates missing files, refuses non-jsonl", () => {
		const cwd = prepare();
		const transcript = persist(SessionManager.create(cwd, path.join(cwd, "sessions")));
		expect(SessionManager.deleteSession(transcript)).toBe(true);
		expect(fs.existsSync(transcript)).toBe(false);
		// Missing file: false, not a throw.
		expect(SessionManager.deleteSession(transcript)).toBe(false);
		// Guard: arbitrary files must not be deletable through this API.
		const other = path.join(root, "notes.txt");
		fs.writeFileSync(other, "keep me\n");
		expect(() => SessionManager.deleteSession(other)).toThrow(/non-session file/i);
		expect(fs.existsSync(other)).toBe(true);
	});
});
