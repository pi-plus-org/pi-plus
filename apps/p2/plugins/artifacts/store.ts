import type { Ctx, Ref } from "@p2/app/v1";
import { ARTIFACTS, type Files, readWhole } from "@p2/app/v1/node";

export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TYPES = ["html", "svg", "markdown", "text"] as const;

export type ArtifactType = (typeof TYPES)[number];
export type ArtifactInfo = { name: string; title: string; type: ArtifactType; version: number };
export type ArtifactInput = { name: string; title: string; type: ArtifactType; content: string };

const DIAGNOSTIC_BOOTSTRAP = `<script>(()=>{const channel="p2-artifact-diagnostic";const send=(level,args)=>{try{parent.postMessage({channel,level,message:args.map(value=>{try{return typeof value==="string"?value:JSON.stringify(value)}catch{return String(value)}}).join(" ").slice(0,4000)},"*")}catch{}};for(const level of ["error","warn"]){const original=console[level];console[level]=(...args)=>{send(level,args);original.apply(console,args)}}addEventListener("error",event=>send("error",[event.message,event.filename&&(event.filename+":"+event.lineno+":"+event.colno)].filter(Boolean)));addEventListener("unhandledrejection",event=>send("error",[event.reason?.stack||event.reason||"Unhandled promise rejection"]));addEventListener("securitypolicyviolation",event=>send("csp",[event.violatedDirective,event.blockedURI||"blocked"]));addEventListener("webglcontextlost",event=>send("webgl",["WebGL context lost"]),true);send("ready",["Preview diagnostics connected"]);})();</script>`;

/** Add a diagnostics bridge without changing the immutable stored source. */
export function instrumentArtifact(info: ArtifactInfo, content: string): string {
	if (info.type === "html") {
		const head = /<head(?:\s[^>]*)?>/i.exec(content);
		if (head)
			return `${content.slice(0, head.index + head[0].length)}${DIAGNOSTIC_BOOTSTRAP}${content.slice(head.index + head[0].length)}`;
		return `${DIAGNOSTIC_BOOTSTRAP}${content}`;
	}
	if (info.type === "svg") {
		const root = /<svg(?:\s[^>]*)?>/i.exec(content);
		if (root)
			return `${content.slice(0, root.index + root[0].length)}${DIAGNOSTIC_BOOTSTRAP}${content.slice(root.index + root[0].length)}`;
	}
	return content;
}

export class ArtifactError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ArtifactError";
		this.status = status;
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validName(name: unknown): name is string {
	return typeof name === "string" && name.trim() === name && NAME.test(name);
}

function validVersion(version: unknown): version is number {
	return typeof version === "number" && Number.isSafeInteger(version) && version > 0;
}

function validTitle(title: unknown): title is string {
	return (
		typeof title === "string" &&
		title.length > 0 &&
		title.length <= 200 &&
		title.trim() === title &&
		title.isWellFormed() &&
		!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)
	);
}

function validType(type: unknown): type is ArtifactType {
	return TYPES.some((candidate) => candidate === type);
}

function validateInput(value: unknown): ArtifactInput {
	if (!record(value) || Object.keys(value).sort().join(",") !== "content,name,title,type")
		throw new ArtifactError(400, "Invalid artifact fields");
	if (!validName(value.name)) throw new ArtifactError(400, "Invalid artifact name");
	if (!validTitle(value.title)) throw new ArtifactError(400, "Invalid artifact title (1–200 characters)");
	if (!validType(value.type)) throw new ArtifactError(400, "Invalid artifact type");
	if (typeof value.content !== "string" || !value.content.isWellFormed())
		throw new ArtifactError(400, "Invalid artifact content");
	if (Buffer.byteLength(value.content, "utf8") > MAX_ARTIFACT_BYTES)
		throw new ArtifactError(413, "Artifact content exceeds 2 MiB");
	return { name: value.name, title: value.title, type: value.type, content: value.content };
}

/** The type an artifact's bytes are stored with. */
const MIME: Record<ArtifactType, string> = {
	html: "text/html",
	svg: "image/svg+xml",
	markdown: "text/markdown",
	text: "text/plain",
};

/**
 * Saves `input` as the next version of its artifact in the session's files (space `artifacts`, path = its name, Files
 * versions = artifact versions, never reused), written by the agent of conversation `ref`. Locators do not authorize
 * access; callers must authorize the session.
 */
export async function saveArtifact(
	files: Ref<typeof Files>,
	input: ArtifactInput,
	ref: string,
	ctx: Ctx,
): Promise<ArtifactInfo> {
	const value = validateInput(input);
	const file = await files.put(
		{
			space: ARTIFACTS,
			path: value.name,
			mime: MIME[value.type],
			source: "agent",
			ref,
			meta: { title: value.title, type: value.type },
			bytes: Buffer.from(value.content, "utf8"),
		},
		ctx,
	);
	return { name: value.name, title: value.title, type: value.type, version: file.version };
}

/** Version `version` of artifact `name` of the session's files; a missing or invalid one is "Artifact not found". */
export async function readArtifact(
	files: Ref<typeof Files>,
	name: string,
	version: number,
	ctx: Ctx,
): Promise<{ info: ArtifactInfo; content: string }> {
	if (!validName(name) || !validVersion(version)) throw new ArtifactError(404, "Artifact not found");
	const file = await files.get({ space: ARTIFACTS, path: name, version }, ctx);
	if (file === null || file.size > MAX_ARTIFACT_BYTES) throw new ArtifactError(404, "Artifact not found");
	const bytes = await readWhole(files, file, ctx);
	const content = bytes.toString("utf8");
	const meta = record(file.meta) ? file.meta : {};
	try {
		const value = validateInput({ name, title: meta.title, type: meta.type, content });
		if (!bytes.equals(Buffer.from(content, "utf8"))) throw new Error("Invalid UTF-8");
		return { info: { name, title: value.title, type: value.type, version }, content: value.content };
	} catch {
		throw new ArtifactError(404, "Artifact not found");
	}
}
