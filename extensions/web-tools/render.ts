import {
	formatSize,
	type AgentToolResult,
	type Theme,
	type ToolDefinition,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Details as FetchDetails } from "./fetch-types.js";
import type { Details as SearchDetails } from "./search-types.js";

type RenderContext = Pick<Parameters<NonNullable<ToolDefinition["renderResult"]>>[3], "isError">;

export const SEARCH_URL = "https://html.duckduckgo.com/html/";

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

export function buildSearchUrl(query: string): URL {
	const url = new URL(SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("kl", "wt-wt");
	url.searchParams.set("kp", "-1");
	return url;
}

function getResultText<TDetails>(result: AgentToolResult<TDetails>): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function renderSearchCall(args: { query?: string }, theme: Theme): Text {
	const title = theme.fg("toolTitle", theme.bold("Web Search"));
	const query = args.query?.trim();
	if (!query) return new Text(title, 0, 0);

	const searchUrl = buildSearchUrl(query).href;
	return new Text(`${title} ${theme.fg("accent", searchUrl)}`, 0, 0);
}

export function renderSearchResult(
	result: AgentToolResult<SearchDetails>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Text {
	if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);

	const output = getResultText(result);
	const details = result.details;
	if (context.isError || !details) {
		return new Text(theme.fg("error", output || "Search failed"), 0, 0);
	}

	const count = details.results.length;
	const summary = [
		count === 0 ? "No results" : "✓",
		`HTTP ${details.status}`,
		count === 0 ? undefined : `${count} ${count === 1 ? "result" : "results"}`,
		`${formatSize(details.bytes)} HTML`,
		`${details.elapsedMs}ms`,
		details.cached ? "cached" : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	let text = theme.fg(count === 0 ? "warning" : "success", summary);
	if (expanded && output) text += `\n${theme.fg("toolOutput", output)}`;
	return new Text(text, 0, 0);
}

export function renderFetchCall(args: { url?: string }, theme: Theme): Text {
	const title = theme.fg("toolTitle", theme.bold("Web Fetch"));
	return new Text(args.url ? `${title} ${theme.fg("accent", getDisplayUrl(args.url))}` : title, 0, 0);
}

export function renderFetchResult(
	result: AgentToolResult<FetchDetails>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
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
