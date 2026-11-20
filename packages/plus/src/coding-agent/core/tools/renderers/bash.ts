/**
 * Wrapper for packages/coding-agent/src/core/tools/renderers/bash.ts.
 *
 * Pass-through except the shell tools' renderResult (shared by bash and
 * powershell, whose tool definitions spread createShellRenderers): a folded
 * card shows only the command line plus a hidden-line count instead of
 * upstream's 5-line output preview. Cards for failed commands keep the tail
 * preview so the appended "Command exited with code N" line stays visible —
 * the same fold contract the read card already has (output hidden unless
 * expanded or errored). Expansion via app.tools.expand (ctrl+o) or click is
 * unchanged, as are the truncation warnings, the full-output path and the
 * duration line.
 *
 * The render internals are forked from the upstream module because
 * rebuildBashResultRenderComponent is module-private there; keep this fork in
 * sync with the upstream file when it changes.
 */
export * from "../../../../../../coding-agent/src/core/tools/renderers/bash.ts";

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type {
	ToolDefinition,
	ToolRenderResultOptions,
} from "../../../../../../coding-agent/src/core/extensions/types.ts";
import type { BashToolDetails } from "../../../../../../coding-agent/src/core/tools/bash.ts";
import { getTextOutput, toolTimerText } from "../../../../../../coding-agent/src/core/tools/render-utils.ts";
import { createShellRenderers as createUpstreamShellRenderers } from "../../../../../../coding-agent/src/core/tools/renderers/bash.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../../../../../../coding-agent/src/core/tools/truncate.ts";
import { keyHint } from "../../../../../../coding-agent/src/modes/interactive/components/keybinding-hints.ts";
import { VisualLinePreview } from "../../../../../../coding-agent/src/modes/interactive/components/visual-truncate.ts";
import { theme } from "../../../../../../coding-agent/src/modes/interactive/theme/theme.ts";

const BASH_PREVIEW_LINES = 5;

type ShellRenderResult = ToolDefinition<any, any>["renderResult"];

function rebuildFoldedShellResultComponent(
	component: Container,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	timerText: string | undefined,
	isError: boolean,
): void {
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else if (isError) {
			// Folded cards hide successful output by default; errors keep the tail
			// preview so the appended exit status line stays visible.
			component.addChild(new Spacer(1));
			component.addChild(
				new VisualLinePreview({
					text: styledOutput,
					maxVisualLines: BASH_PREVIEW_LINES,
					keep: "end",
					formatHint: (hidden) =>
						theme.fg("muted", `... (${hidden} earlier lines,`) +
						` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
				}),
			);
		} else {
			const lineCount = output.split("\n").length;
			component.addChild(
				new Text(
					`\n${theme.fg("muted", `(${lineCount} lines hidden,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					0,
					0,
				),
			);
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (timerText) component.addChild(new Text(`\n${theme.fg("muted", timerText)}`, 0, 0));
}

const foldedShellRenderResult: ShellRenderResult = (result, options, _theme, context) => {
	const timerText = toolTimerText(context, options.isPartial);
	const component = (context.lastComponent as Container | undefined) ?? new Container();
	rebuildFoldedShellResultComponent(component, result as any, options, context.showImages, timerText, context.isError);
	component.invalidate();
	return component;
};

export function createShellRenderers(prompt: string): ReturnType<typeof createUpstreamShellRenderers> {
	const upstream = createUpstreamShellRenderers(prompt);
	return {
		renderCall: upstream.renderCall,
		renderResult: foldedShellRenderResult,
	};
}
