/**
 * Tests for the pi-plus AgentSession addition getSlashCommands
 * (plus/src/coding-agent/core/agent-session.ts): the session-executable
 * slash-command set — extension commands, prompt templates, and `skill:<name>`
 * entries — exposed to embedding hosts. Upstream stays pristine (the extension
 * core rebuilds the same set through a private closure), so this exercises the
 * subclass method against structural fakes of the privates it reads, the same
 * cast the method itself uses.
 */

import { describe, expect, it } from "vitest";
import type { SlashCommandInfo } from "../../../coding-agent/src/core/slash-commands.ts";
import type { SourceInfo } from "../../../coding-agent/src/core/source-info.ts";
import { AgentSession } from "../../src/coding-agent/core/agent-session.ts";

const sourceInfo = { path: "test/source.ts", source: "test", scope: "user", origin: "file" } as unknown as SourceInfo;

/** Structural stand-in for what getSlashCommands reads off the session. */
interface SlashCommandHost {
	_extensionRunner?: {
		getRegisteredCommands(): { invocationName: string; description?: string; sourceInfo: SourceInfo }[];
	};
	promptTemplates: { name: string; description?: string; sourceInfo: SourceInfo }[];
	_resourceLoader: {
		getSkills(): { skills: { name: string; description?: string; sourceInfo: SourceInfo }[] };
	};
}

function collect(host: SlashCommandHost): SlashCommandInfo[] {
	const method = AgentSession.prototype.getSlashCommands as unknown as (this: SlashCommandHost) => SlashCommandInfo[];
	return method.call(host);
}

describe("AgentSession.getSlashCommands", () => {
	it("merges extension commands, prompt templates, and skills in order", () => {
		const host: SlashCommandHost = {
			_extensionRunner: {
				getRegisteredCommands: () => [{ invocationName: "plan", description: "Enter plan mode", sourceInfo }],
			},
			promptTemplates: [{ name: "tpl", description: "A template", sourceInfo }],
			_resourceLoader: { getSkills: () => ({ skills: [{ name: "sk", description: "A skill", sourceInfo }] }) },
		};
		expect(collect(host)).toEqual([
			{ name: "plan", description: "Enter plan mode", source: "extension", sourceInfo },
			{ name: "tpl", description: "A template", source: "prompt", sourceInfo },
			{ name: "skill:sk", description: "A skill", source: "skill", sourceInfo },
		]);
	});

	it("yields no extension entries before an extension runner exists", () => {
		const host: SlashCommandHost = {
			promptTemplates: [{ name: "tpl", description: "A template", sourceInfo }],
			_resourceLoader: { getSkills: () => ({ skills: [] }) },
		};
		expect(collect(host)).toEqual([{ name: "tpl", description: "A template", source: "prompt", sourceInfo }]);
	});

	it("returns an empty set for a session with no resources", () => {
		const host: SlashCommandHost = {
			promptTemplates: [],
			_resourceLoader: { getSkills: () => ({ skills: [] }) },
		};
		expect(collect(host)).toEqual([]);
	});
});
