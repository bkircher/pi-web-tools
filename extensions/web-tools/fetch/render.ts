import { formatSize, type AgentToolResult, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getResultText, type RenderContext, type RenderTheme } from "../shared/render.js";
import type { FetchParameters } from "./parameters.js";
import type { Details as FetchDetails } from "./types.js";

const UNSAFE_TERMINAL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

function escapeUnsafeCharacters(value: string): string {
	return value.replace(UNSAFE_TERMINAL_PATTERN, (character) => {
		const codePoint = character.codePointAt(0)!;
		return `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
	});
}

function getDisplayUrl(value: string): string {
	try {
		return new URL(value).href;
	} catch {
		return escapeUnsafeCharacters(value);
	}
}

export function renderFetchCall(args: FetchParameters, theme: RenderTheme): Text {
	const title = theme.fg("toolTitle", theme.bold("Web Fetch"));
	return new Text(args.url ? `${title} ${theme.fg("accent", getDisplayUrl(args.url))}` : title, 0, 0);
}

export function renderFetchResult(
	result: AgentToolResult<FetchDetails>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: RenderTheme,
	context: RenderContext,
): Text {
	if (isPartial) return new Text(theme.fg("warning", "Fetching…"), 0, 0);

	const output = getResultText(result);
	const details = result.details;
	if (context.isError || !details) {
		return new Text(theme.fg("error", output || "Fetch failed"), 0, 0);
	}

	const mode = details.mode === "dump" ? details.dump : "eval";
	const truncationLabel = details.truncated ? " · truncated" : "";
	const stderrLabel = details.stderr ? " · stderr" : "";
	let text = theme.fg(
		details.truncated || details.stderr ? "warning" : "success",
		`✓ ${mode} · ${formatSize(details.bytes)} output · ${details.elapsedMs}ms${truncationLabel}${stderrLabel}`,
	);
	if (expanded && output) text += `\n${theme.fg("toolOutput", output)}`;
	return new Text(text, 0, 0);
}
