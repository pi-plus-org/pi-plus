/**
 * Wrapper for packages/coding-agent/src/modes/interactive/components/footer.ts.
 *
 * Pass-through except: the current permission mode (pi-plus-permissions) is
 * rendered right-aligned on the cwd line, next to the pwd/branch text, with
 * Claude Code-style icons (✈️ bypass / ✏️ accept-edits / ⏸ plan). The mode
 * lives in the shared holder from the permissions extension
 * (packages/plus/src/extensions/permissions/index.ts), which the CLI host
 * uses as its default state, so the footer reads the same truth the tool
 * gate enforces. Prototype-patched like the interactive-mode wrapper: every
 * `new FooterComponent(...)` call site upstream picks this up through the
 * redirect.
 */

export * from "../../../../../../coding-agent/src/modes/interactive/components/footer.ts";

import { visibleWidth } from "@earendil-works/pi-tui";
import { FooterComponent } from "../../../../../../coding-agent/src/modes/interactive/components/footer.ts";
import { theme } from "../../../../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { permissionStatusText, sharedPermissionState } from "../../../../extensions/permissions/index.ts";

const originalRender = FooterComponent.prototype.render;

FooterComponent.prototype.render = function render(width: number): string[] {
	const lines = originalRender.call(this, width);
	if (lines.length === 0 || width <= 0) return lines;

	// Right-align the permission mode on the cwd line, keeping at least one
	// space after the pwd text. Skip when the line is already full.
	const status = permissionStatusText(sharedPermissionState.mode, theme);
	const statusWidth = visibleWidth(status);
	const pwdWidth = visibleWidth(lines[0]);
	if (statusWidth + 1 > width - pwdWidth) return lines;

	lines[0] = lines[0] + " ".repeat(width - pwdWidth - statusWidth) + status;
	return lines;
};
