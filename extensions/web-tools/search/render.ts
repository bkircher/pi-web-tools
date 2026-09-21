import { formatSize, type AgentToolResult, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getResultText, type RenderContext, type RenderTheme } from "../shared/render.js";
import { buildSearchUrl } from "./duckduckgo.js";
import type { SearchParameters } from "./parameters.js";
import type { Details as SearchDetails } from "./types.js";

export function renderSearchCall(args: SearchParameters, theme: RenderTheme): Text {
	const title = theme.fg("toolTitle", theme.bold("Web Search"));
	const query = args.query?.trim();
	if (!query) return new Text(title, 0, 0);

	const searchUrl = buildSearchUrl(query).href;
	return new Text(`${title} ${theme.fg("accent", searchUrl)}`, 0, 0);
}

export function renderSearchResult(
	result: AgentToolResult<SearchDetails>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: RenderTheme,
	context: RenderContext,
): Text {
	if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);

	const output = getResultText(result);
	const details = result.details;
	if (context.isError || !details) {
		return new Text(theme.fg("error", output || "Search failed"), 0, 0);
	}

	const count = details.results.length;
	const stderr = details.stderr;
	const summary = [
		count === 0 ? "No results" : "✓",
		"Obscura",
		count === 0 ? undefined : `${count} ${count === 1 ? "result" : "results"}`,
		`${formatSize(details.bytes)} output`,
		`${details.elapsedMs}ms`,
		details.cached ? "cached" : undefined,
		stderr ? "stderr" : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	let text = theme.fg(count === 0 || stderr ? "warning" : "success", summary);
	if (expanded && output) text += `\n${theme.fg("toolOutput", output)}`;
	return new Text(text, 0, 0);
}
