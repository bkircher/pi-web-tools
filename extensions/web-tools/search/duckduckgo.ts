import type { Result, UntrustedResult } from "./types.js";

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

export function normalizeResults(rawResults: UntrustedResult[]): Result[] {
	const results: Result[] = [];
	const seen = new Set<string>();

	for (const rawResult of rawResults) {
		const title = normalizeWhitespace(rawResult.title);
		const url = normalizeResultUrl(rawResult.href);
		if (!title || !url || seen.has(url)) continue;

		const snippet = rawResult.snippet === undefined ? undefined : normalizeWhitespace(rawResult.snippet);
		seen.add(url);
		results.push({
			title,
			url,
			...(snippet ? { snippet } : {}),
		});
	}

	return results;
}
