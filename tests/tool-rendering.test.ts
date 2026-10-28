import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import {
	renderFetchCall as renderWebFetchCall,
	renderFetchResult as renderWebFetchResult,
} from "../extensions/web-tools/fetch/render.ts";
import type { Details as WebFetchDetails } from "../extensions/web-tools/fetch/types.ts";
import {
	renderSearchCall as renderWebSearchCall,
	renderSearchResult as renderWebSearchResult,
} from "../extensions/web-tools/search/render.ts";
import type { Details as SearchDetails } from "../extensions/web-tools/search/types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} satisfies Pick<Theme, "fg" | "bold">;

const renderContext = { isError: false };

function renderLines(component: { render(width: number): string[] }): string[] {
	return component.render(500).map((line) => line.trimEnd());
}

function createSearchResult(overrides: Partial<SearchDetails> = {}): AgentToolResult<SearchDetails> {
	return {
		content: [{ type: "text", text: "1. pnpm\n   https://pnpm.io/" }],
		details: {
			backend: "obscura",
			searchUrl: "https://html.duckduckgo.com/html/?q=pnpm",
			bytes: 123,
			results: [{ title: "pnpm", url: "https://pnpm.io/" }],
			query: "pnpm",
			limit: 10,
			cached: true,
			elapsedMs: 3,
			...overrides,
		},
	};
}

function createFetchResult(): AgentToolResult<WebFetchDetails> {
	return {
		content: [{ type: "text", text: "# Example\n\nFetched page content" }],
		details: {
			url: "https://example.com/",
			waitUntil: "load",
			wait: 5,
			timeout: 30,
			stealth: true,
			proxy: false,
			mode: "dump",
			dump: "markdown",
			bytes: 2048,
			elapsedMs: 750,
			truncated: false,
		},
	};
}

test("renders the web_search request URL", () => {
	const component = renderWebSearchCall({ query: "pnpm docs" }, theme);

	const lines = renderLines(component);

	assert.deepEqual(lines, ["Web Search https://html.duckduckgo.com/html/?q=pnpm+docs&kl=wt-wt&kp=-1"]);
});

test("hides web_search content when collapsed", () => {
	const result = createSearchResult({
		results: [
			{ title: "pnpm", url: "https://pnpm.io/" },
			{ title: "Docs", url: "https://pnpm.io/motivation" },
		],
		cached: false,
		elapsedMs: 42,
	});

	const component = renderWebSearchResult(result, { expanded: false, isPartial: false }, theme, renderContext);

	assert.deepEqual(renderLines(component), ["✓ · Obscura · 2 results · 123B output · 42ms"]);
});

test("shows web_search content when expanded", () => {
	const result = createSearchResult();

	const component = renderWebSearchResult(result, { expanded: true, isPartial: false }, theme, renderContext);

	assert.deepEqual(renderLines(component), [
		"✓ · Obscura · 1 result · 123B output · 3ms · cached",
		"1. pnpm",
		"   https://pnpm.io/",
	]);
});

test("renders the web_fetch request URL", () => {
	const component = renderWebFetchCall({ url: "https://example.com/docs" }, theme);

	const lines = renderLines(component);

	assert.deepEqual(lines, ["Web Fetch https://example.com/docs"]);
});

test("percent-encodes control characters in valid URLs", () => {
	const component = renderWebFetchCall({ url: "https://example.com/\u001b]52;c;SGVsbG8=\u0007/end" }, theme);

	const lines = renderLines(component);

	assert.deepEqual(lines, ["Web Fetch https://example.com/%1B]52;c;SGVsbG8=%07/end"]);
});

test("escapes control characters in invalid URLs", () => {
	const component = renderWebFetchCall({ url: "invalid\u001b[31m\nurl\u009d\u202e" }, theme);

	const lines = renderLines(component);

	assert.deepEqual(lines, ["Web Fetch invalid\\u001B[31m\\u000Aurl\\u009D\\u202E"]);
});

test("hides web_fetch content when collapsed", () => {
	const result = createFetchResult();

	const component = renderWebFetchResult(result, { expanded: false, isPartial: false }, theme, renderContext);

	assert.deepEqual(renderLines(component), ["✓ markdown · 2.0KB output · 750ms"]);
});

test("shows web_fetch content when expanded", () => {
	const result = createFetchResult();

	const component = renderWebFetchResult(result, { expanded: true, isPartial: false }, theme, renderContext);

	assert.deepEqual(renderLines(component), [
		"✓ markdown · 2.0KB output · 750ms",
		"# Example",
		"",
		"Fetched page content",
	]);
});
