import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseDuckDuckGoHtml, type SearchResult } from "./duckduckgo.js";

export type { SearchResult } from "./duckduckgo.js";

type CacheEntry = {
	expiresAt: number;
	results: SearchResult[];
};

export type WebSearchDetails = {
	query: string;
	limit: number;
	cached: boolean;
	elapsedMs: number;
	resultCount: number;
	results: SearchResult[];
};

const SEARCH_URL = "https://html.duckduckgo.com/html/";
const SEARCH_HOSTNAME = new URL(SEARCH_URL).hostname;
const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const MAX_QUERY_LENGTH = 500;
const MAX_LIMIT = 20;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

const cache = new Map<string, CacheEntry>();

const webSearchParams = Type.Object({
	query: Type.String({
		description: "Search query to send to DuckDuckGo HTML search",
		minLength: 1,
		maxLength: MAX_QUERY_LENGTH,
	}),
	limit: Type.Optional(
		Type.Integer({
			description: `Maximum number of search results to return (1-${MAX_LIMIT}, default 10)`,
			minimum: 1,
			maximum: MAX_LIMIT,
		}),
	),
});

function cacheKey(query: string): string {
	return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function getCached(query: string): SearchResult[] | undefined {
	const key = cacheKey(query);
	const entry = cache.get(key);
	if (!entry) return undefined;
	if (entry.expiresAt <= Date.now()) {
		cache.delete(key);
		return undefined;
	}

	// Refresh insertion order for simple LRU behavior.
	cache.delete(key);
	cache.set(key, entry);
	return entry.results;
}

function setCached(query: string, results: SearchResult[]): void {
	cache.set(cacheKey(query), {
		expiresAt: Date.now() + CACHE_TTL_MS,
		results,
	});

	while (cache.size > MAX_CACHE_ENTRIES) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey === undefined) break;
		cache.delete(oldestKey);
	}
}

function makeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function formatResults(results: SearchResult[]): string {
	return results
		.map((result, index) => {
			const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`];
			if (result.snippet) lines.push(`   ${result.snippet}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

function throwDuckDuckGoHtmlTooLarge(): never {
	throw new Error(`DuckDuckGo returned more than ${MAX_HTML_BYTES} bytes of HTML`);
}

async function readDuckDuckGoHtml(response: Response): Promise<string> {
	const contentLength = response.headers.get("content-length");
	if (contentLength) {
		const contentLengthBytes = Number(contentLength);
		if (Number.isFinite(contentLengthBytes) && contentLengthBytes > MAX_HTML_BYTES) {
			throwDuckDuckGoHtmlTooLarge();
		}
	}

	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let html = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			bytes += value.byteLength;
			if (bytes > MAX_HTML_BYTES) {
				await reader.cancel().catch(() => {});
				throwDuckDuckGoHtmlTooLarge();
			}

			html += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}

	html += decoder.decode();
	return html;
}

function isRedirectStatus(status: number): boolean {
	return status >= 300 && status < 400;
}

function getRedirectHostname(location: string, baseUrl: URL): string | undefined {
	try {
		return new URL(location, baseUrl).hostname;
	} catch {
		return undefined;
	}
}

async function fetchDuckDuckGoHtml(query: string, signal: AbortSignal | undefined): Promise<string> {
	const url = new URL(SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("kl", "wt-wt");
	url.searchParams.set("kp", "-1");

	const response = await fetch(url, {
		headers: {
			accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"accept-language": "en-US,en;q=0.9",
			"user-agent": "Mozilla/5.0",
		},
		redirect: "manual",
		signal: makeSignal(signal, 10_000),
	});

	if (isRedirectStatus(response.status)) {
		const location = response.headers.get("location");
		const redirectHostname = location ? getRedirectHostname(location, url) : undefined;
		if (redirectHostname && redirectHostname !== SEARCH_HOSTNAME) {
			throw new Error(`DuckDuckGo search redirected to unexpected host: ${redirectHostname}`);
		}
		throw new Error(`DuckDuckGo search redirected unexpectedly: HTTP ${response.status}`);
	}

	if (!response.ok) {
		throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`);
	}

	return readDuckDuckGoHtml(response);
}

/**
 * Register the `web_search` tool, which searches DuckDuckGo's non-JavaScript HTML endpoint.
 */
export function registerWebSearchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using DuckDuckGo's non-JavaScript HTML search page. Returns result titles, URLs, and snippets; does not fetch result pages.",
		promptSnippet: "Search the web with DuckDuckGo HTML search and return titles, URLs, and snippets.",
		promptGuidelines: [
			"Use web_search when the user asks for current or external web information that is not available in the repository.",
			"When using web_search results in an answer, cite the relevant result URLs.",
		],
		parameters: webSearchParams,

		async execute(_toolCallId, params, signal): Promise<AgentToolResult<WebSearchDetails>> {
			const query = params.query.trim();
			const limit = params.limit ?? 10;
			if (!query) throw new Error("Search query must not be empty");

			const startedAt = Date.now();
			const cached = getCached(query);
			const allResults = cached ?? parseDuckDuckGoHtml(await fetchDuckDuckGoHtml(query, signal), MAX_LIMIT);
			if (!cached) setCached(query, allResults);

			if (allResults.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No search results found. The DuckDuckGo HTML format may also have changed.",
						},
					],
					details: {
						query,
						limit,
						cached: Boolean(cached),
						elapsedMs: Date.now() - startedAt,
						resultCount: 0,
						results: [],
					},
				};
			}

			const results = allResults.slice(0, limit);
			return {
				content: [{ type: "text", text: formatResults(results) }],
				details: {
					query,
					limit,
					cached: Boolean(cached),
					elapsedMs: Date.now() - startedAt,
					resultCount: results.length,
					results,
				},
			};
		},
	});
}
