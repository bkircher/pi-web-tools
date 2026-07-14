import { formatSize, type AgentToolResult, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export type WebToolRenderOptions = {
	expanded: boolean;
	isPartial: boolean;
};

export type WebToolRenderContext = {
	isError: boolean;
};

type SearchRenderDetails = {
	status?: number;
	bytes?: number;
	results?: unknown[];
	resultCount?: number;
	cached: boolean;
	elapsedMs: number;
};

type FetchRenderDetails = {
	mode: "dump" | "eval";
	dump?: string;
	bytes: number;
	elapsedMs: number;
	truncated: boolean;
	stderr?: string;
};

export const DUCKDUCKGO_SEARCH_URL = "https://html.duckduckgo.com/html/";

const UNSAFE_TERMINAL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

function escapeUnsafeTerminalCharacters(value: string): string {
	return value.replace(UNSAFE_TERMINAL_CHARACTER_PATTERN, (character) => {
		const codePoint = character.codePointAt(0)!;
		return `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
	});
}

function getDisplayUrl(value: string): string {
	try {
		return new URL(value).href;
	} catch {
		return escapeUnsafeTerminalCharacters(value);
	}
}

export function buildDuckDuckGoSearchUrl(query: string): URL {
	const url = new URL(DUCKDUCKGO_SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("kl", "wt-wt");
	url.searchParams.set("kp", "-1");
	return url;
}

function getResultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function renderWebSearchCall(args: { query?: string }, theme: Theme): Text {
	const title = theme.fg("toolTitle", theme.bold("Web Search"));
	const query = args.query?.trim();
	if (!query) return new Text(title, 0, 0);

	const searchUrl = buildDuckDuckGoSearchUrl(query).href;
	return new Text(`${title} ${theme.fg("accent", searchUrl)}`, 0, 0);
}

export function renderWebSearchResult(
	result: AgentToolResult<unknown>,
	{ expanded, isPartial }: WebToolRenderOptions,
	theme: Theme,
	context: WebToolRenderContext,
): Text {
	if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);

	const output = getResultText(result);
	const details = result.details as SearchRenderDetails | undefined;
	if (context.isError || !details) {
		return new Text(theme.fg("error", output || "Search failed"), 0, 0);
	}

	const count = details.resultCount ?? details.results?.length;
	if (count === undefined) {
		return new Text(theme.fg("error", output || "Search result details unavailable"), 0, 0);
	}

	const summary = [
		count === 0 ? "No results" : "✓",
		details.status === undefined ? undefined : `HTTP ${details.status}`,
		count === 0 ? undefined : `${count} ${count === 1 ? "result" : "results"}`,
		details.bytes === undefined ? undefined : `${formatSize(details.bytes)} HTML`,
		`${details.elapsedMs}ms`,
		details.cached ? "cached" : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
	let text = theme.fg(count === 0 ? "warning" : "success", summary);
	if (expanded && output) text += `\n${theme.fg("toolOutput", output)}`;
	return new Text(text, 0, 0);
}

export function renderWebFetchCall(args: { url?: string }, theme: Theme): Text {
	const title = theme.fg("toolTitle", theme.bold("Web Fetch"));
	return new Text(args.url ? `${title} ${theme.fg("accent", getDisplayUrl(args.url))}` : title, 0, 0);
}

export function renderWebFetchResult(
	result: AgentToolResult<unknown>,
	{ expanded, isPartial }: WebToolRenderOptions,
	theme: Theme,
	context: WebToolRenderContext,
): Text {
	if (isPartial) return new Text(theme.fg("warning", "Fetching…"), 0, 0);

	const output = getResultText(result);
	const details = result.details as FetchRenderDetails | undefined;
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
