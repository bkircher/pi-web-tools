import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	renderWebFetchCall,
	renderWebFetchResult,
	renderWebSearchCall,
	renderWebSearchResult,
} from "../extensions/web-tools/render.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const renderContext = { isError: false };

function renderLines(component: { render(width: number): string[] }): string[] {
	return component.render(500).map((line) => line.trimEnd());
}

test("web_search renders the exact DuckDuckGo request URL", () => {
	const component = renderWebSearchCall({ query: "pnpm docs" }, theme);

	const lines = renderLines(component);

	assert.deepEqual(lines, ["Web Search https://html.duckduckgo.com/html/?q=pnpm+docs&kl=wt-wt&kp=-1"]);
});

test("web_search keeps result content hidden in the collapsed summary", () => {
	const result = {
		content: [{ type: "text" as const, text: "1. pnpm\n   https://pnpm.io/" }],
		details: {
			status: 200,
			bytes: 123,
			results: [
				{ title: "pnpm", url: "https://pnpm.io/" },
				{ title: "Docs", url: "https://pnpm.io/motivation" },
			],
			cached: false,
			elapsedMs: 42,
		},
	};

	const component = renderWebSearchResult(result, { expanded: false, isPartial: false }, theme, renderContext);

	assert.deepEqual(renderLines(component), ["✓ · HTTP 200 · 2 results · 123B HTML · 42ms"]);
});

test("web_search derives the count from results when a persisted count differs", () => {
	const result = {
		content: [{ type: "text" as const, text: "Search output" }],
		details: {
			results: [
				{ title: "pnpm", url: "https://pnpm.io/" },
				{ title: "Docs", url: "https://pnpm.io/motivation" },
			],
			resultCount: 99,
			cached: false,
			elapsedMs: 42,
		},
	};

	const component = renderWebSearchResult(result, { expanded: false, isPartial: false }, theme, renderContext);

	assert.deepEqual(renderLines(component), ["✓ · 2 results · 42ms"]);
});

test("web_search renders summaries from legacy details without results", () => {
	const result = {
		content: [{ type: "text" as const, text: "1. pnpm\n   https://pnpm.io/" }],
		details: {
			resultCount: 2,
			cached: false,
			elapsedMs: 42,
		},
	};

	const component = renderWebSearchResult(result, { expanded: false, isPartial: false }, theme, renderContext);

	assert.deepEqual(renderLines(component), ["✓ · 2 results · 42ms"]);
});

test("web_search displays result content when expanded", () => {
	const result = {
		content: [{ type: "text" as const, text: "1. pnpm\n   https://pnpm.io/" }],
		details: {
			status: 200,
			bytes: 123,
			results: [{ title: "pnpm", url: "https://pnpm.io/" }],
			cached: true,
			elapsedMs: 3,
		},
	};

	const component = renderWebSearchResult(result, { expanded: true, isPartial: false }, theme, renderContext);

	assert.deepEqual(renderLines(component), [
		"✓ · HTTP 200 · 1 result · 123B HTML · 3ms · cached",
		"1. pnpm",
		"   https://pnpm.io/",
	]);
});

test("web_fetch renders the requested URL", () => {
	const component = renderWebFetchCall({ url: "https://example.com/docs" }, theme);

	const lines = renderLines(component);

	assert.deepEqual(lines, ["Web Fetch https://example.com/docs"]);
});

test("web_fetch percent-encodes terminal control characters in valid URLs", () => {
	const component = renderWebFetchCall({ url: "https://example.com/\u001b]52;c;SGVsbG8=\u0007/end" }, theme);

	const lines = renderLines(component);

	assert.deepEqual(lines, ["Web Fetch https://example.com/%1B]52;c;SGVsbG8=%07/end"]);
});

test("web_fetch escapes terminal control characters in invalid URLs", () => {
	const component = renderWebFetchCall({ url: "invalid\u001b[31m\nurl\u009d\u202e" }, theme);

	const lines = renderLines(component);

	assert.deepEqual(lines, ["Web Fetch invalid\\u001B[31m\\u000Aurl\\u009D\\u202E"]);
});

test("web_fetch keeps fetched content hidden in the collapsed summary", () => {
	const result = {
		content: [{ type: "text" as const, text: "# Example\n\nFetched page content" }],
		details: {
			mode: "dump" as const,
			dump: "markdown",
			bytes: 2048,
			elapsedMs: 750,
			truncated: false,
		},
	};

	const component = renderWebFetchResult(result, { expanded: false, isPartial: false }, theme, renderContext);

	assert.deepEqual(renderLines(component), ["✓ markdown · 2.0KB output · 750ms"]);
});

test("web_fetch displays fetched content when expanded", () => {
	const result = {
		content: [{ type: "text" as const, text: "# Example\n\nFetched page content" }],
		details: {
			mode: "dump" as const,
			dump: "markdown",
			bytes: 2048,
			elapsedMs: 750,
			truncated: false,
		},
	};

	const component = renderWebFetchResult(result, { expanded: true, isPartial: false }, theme, renderContext);

	assert.deepEqual(renderLines(component), [
		"✓ markdown · 2.0KB output · 750ms",
		"# Example",
		"",
		"Fetched page content",
	]);
});
