import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decode } from "html-entities";
import { Type } from "typebox";

export type SearchResult = {
	title: string;
	url: string;
	snippet?: string;
};

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

function decodeHtmlEntities(value: string, scope: "body" | "attribute" = "body"): string {
	return decode(value, { level: "html5", scope });
}

function textFromHtml(html: string): string {
	return decodeHtmlEntities(
		html
			.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
			.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]*>/g, " "),
	)
		.replace(/\s+/g, " ")
		.trim();
}

function getAttribute(tag: string, name: string): string | undefined {
	const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
	const match = tag.match(pattern);
	const raw = match?.[1] ?? match?.[2] ?? match?.[3];
	return raw ? decodeHtmlEntities(raw, "attribute") : undefined;
}

function unwrapDuckDuckGoUrl(href: string): string | undefined {
	let url: URL;
	try {
		url = new URL(href, "https://html.duckduckgo.com");
	} catch {
		return undefined;
	}

	const uddg = url.searchParams.get("uddg");
	if (uddg) {
		try {
			url = new URL(uddg);
		} catch {
			return undefined;
		}
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	return url.href;
}

function parseDuckDuckGoHtml(html: string): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	const linkPattern =
		/<a\b([^>]*\bclass\s*=\s*(?:"[^"]*\bresult__a\b[^"]*"|'[^']*\bresult__a\b[^']*'|[^\s>]*\bresult__a\b[^\s>]*)[^>]*)>([\s\S]*?)<\/a>/gi;

	for (const match of html.matchAll(linkPattern)) {
		const fullMatch = match[0];
		const attrs = match[1] ?? "";
		const body = match[2] ?? "";
		const href = getAttribute(`<a ${attrs}>`, "href");
		const url = href ? unwrapDuckDuckGoUrl(href) : undefined;
		const title = textFromHtml(body);

		if (!title || !url || seen.has(url)) continue;

		const afterLink = html.slice((match.index ?? 0) + fullMatch.length, (match.index ?? 0) + fullMatch.length + 4000);
		const snippetMatch = afterLink.match(
			/<(?:a|div)\b[^>]*\bclass\s*=\s*(?:"[^"]*\bresult__snippet\b[^"]*"|'[^']*\bresult__snippet\b[^']*'|[^\s>]*\bresult__snippet\b[^\s>]*)[^>]*>([\s\S]*?)<\/(?:a|div)>/i,
		);
		const snippet = snippetMatch?.[1] ? textFromHtml(snippetMatch[1]) : undefined;

		seen.add(url);
		results.push({
			title,
			url,
			...(snippet ? { snippet } : {}),
		});
	}

	return results;
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
			const allResults = cached ?? parseDuckDuckGoHtml(await fetchDuckDuckGoHtml(query, signal));
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
