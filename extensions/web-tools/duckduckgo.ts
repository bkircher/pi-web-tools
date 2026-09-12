import type { RawResult } from "./search-obscura.js";

export type Result = {
	title: string;
	url: string;
	snippet?: string;
};

const DUCKDUCKGO_ORIGIN = "https://html.duckduckgo.com";
const SEARCH_URL = `${DUCKDUCKGO_ORIGIN}/html/`;

export const MAX_RESULTS = 20;

export function buildSearchUrl(query: string): URL {
	const url = new URL(SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("kl", "wt-wt");
	url.searchParams.set("kp", "-1");
	return url;
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function isDuckDuckGoHost(hostname: string): boolean {
	return hostname === "duckduckgo.com" || hostname.endsWith(".duckduckgo.com");
}

export function normalizeResultUrl(href: string): string | undefined {
	const normalizedHref = href.trim();
	if (!normalizedHref) return undefined;

	let url: URL;
	try {
		url = new URL(normalizedHref, DUCKDUCKGO_ORIGIN);
	} catch {
		return undefined;
	}

	if (isDuckDuckGoHost(url.hostname) && url.pathname === "/l/") {
		const redirectUrl = url.searchParams.get("uddg");
		if (redirectUrl) {
			try {
				url = new URL(redirectUrl);
			} catch {
				return undefined;
			}
		}
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	return url.href;
}

export function normalizeResults(rawResults: RawResult[], maxResults: number): Result[] {
	const limit = Number.isFinite(maxResults) ? Math.max(0, Math.floor(maxResults)) : 0;
	if (limit === 0) return [];

	const results: Result[] = [];
	const seen = new Set<string>();

	for (const rawResult of rawResults) {
		if (typeof rawResult.title !== "string" || typeof rawResult.href !== "string") continue;

		const title = normalizeWhitespace(rawResult.title);
		const url = normalizeResultUrl(rawResult.href);
		if (!title || !url || seen.has(url)) continue;

		const snippet = typeof rawResult.snippet === "string" ? normalizeWhitespace(rawResult.snippet) : undefined;
		seen.add(url);
		results.push({
			title,
			url,
			...(snippet ? { snippet } : {}),
		});
		if (results.length >= limit) break;
	}

	return results;
}
