import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type AgentToolResult,
	type ExtensionAPI,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type SearchResult = {
	title: string;
	url: string;
	snippet?: string;
};

type CacheEntry = {
	expiresAt: number;
	results: SearchResult[];
};

type WebSearchDetails = {
	query: string;
	limit: number;
	cached: boolean;
	elapsedMs: number;
	resultCount: number;
	results: SearchResult[];
};

const WEB_FETCH_DUMP_MODES = ["markdown", "text", "html", "links", "assets"] as const;
const WEB_FETCH_WAIT_UNTIL_VALUES = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;

type WebFetchDumpMode = (typeof WEB_FETCH_DUMP_MODES)[number];
type WebFetchWaitUntil = (typeof WEB_FETCH_WAIT_UNTIL_VALUES)[number];

type WebFetchBaseDetails = {
	url: string;
	waitUntil: WebFetchWaitUntil;
	wait: number;
	timeout: number;
	stealth: true;
	proxy: boolean;
	elapsedMs: number;
	bytes: number;
	truncated: boolean;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	stderr?: string;
};

type WebFetchDetails = WebFetchBaseDetails &
	(
		| { mode: "dump"; dump: WebFetchDumpMode; eval?: never; selector?: string }
		| { mode: "eval"; eval: string; dump?: never; selector?: never }
	);

const SEARCH_URL = "https://html.duckduckgo.com/html/";
const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const MAX_QUERY_LENGTH = 500;
const MAX_LIMIT = 20;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

const DEFAULT_WEB_FETCH_DUMP_MODE = "markdown" satisfies WebFetchDumpMode;
const DEFAULT_WEB_FETCH_WAIT_UNTIL = "load" satisfies WebFetchWaitUntil;
const DEFAULT_WEB_FETCH_WAIT_SECONDS = 5;
const DEFAULT_WEB_FETCH_TIMEOUT_SECONDS = 30;
const MAX_WEB_FETCH_TIMEOUT_SECONDS = 120;
const MAX_WEB_FETCH_WAIT_SECONDS = 60;
const MAX_WEB_FETCH_URL_LENGTH = 4096;
const MAX_WEB_FETCH_EVAL_LENGTH = 5000;
const MAX_WEB_FETCH_SELECTOR_LENGTH = 1000;
const MAX_WEB_FETCH_PROXY_LENGTH = 2048;
const MAX_WEB_FETCH_CAPTURE_BYTES = 10 * 1024 * 1024;

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

const webFetchParams = Type.Object({
	url: Type.String({
		description: "HTTP(S) URL to fetch with Obscura",
		minLength: 1,
		maxLength: MAX_WEB_FETCH_URL_LENGTH,
	}),
	dump: Type.Optional(
		StringEnum(WEB_FETCH_DUMP_MODES, {
			description:
				"Output format to dump when eval is not provided. markdown preserves headings and links while removing most HTML noise. assets returns NDJSON sub-resource URLs.",
			default: DEFAULT_WEB_FETCH_DUMP_MODE,
		}),
	),
	eval: Type.Optional(
		Type.String({
			description:
				"JavaScript expression to evaluate in the rendered page instead of dumping page content. Use document.querySelector(...) inside the expression when you need scoped eval output.",
			minLength: 1,
			maxLength: MAX_WEB_FETCH_EVAL_LENGTH,
		}),
	),
	selector: Type.Optional(
		Type.String({
			description: "Optional CSS selector to wait for before dumping output. Not valid with eval.",
			minLength: 1,
			maxLength: MAX_WEB_FETCH_SELECTOR_LENGTH,
		}),
	),
	waitUntil: Type.Optional(
		StringEnum(WEB_FETCH_WAIT_UNTIL_VALUES, {
			description: "Navigation readiness condition before dumping or evaluating. Default: load",
			default: DEFAULT_WEB_FETCH_WAIT_UNTIL,
		}),
	),
	wait: Type.Optional(
		Type.Integer({
			description: `Extra time to wait after navigation, in seconds (default ${DEFAULT_WEB_FETCH_WAIT_SECONDS})`,
			minimum: 0,
			maximum: MAX_WEB_FETCH_WAIT_SECONDS,
			default: DEFAULT_WEB_FETCH_WAIT_SECONDS,
		}),
	),
	timeout: Type.Optional(
		Type.Integer({
			description: `Navigation timeout in seconds (default ${DEFAULT_WEB_FETCH_TIMEOUT_SECONDS}, max ${MAX_WEB_FETCH_TIMEOUT_SECONDS})`,
			minimum: 1,
			maximum: MAX_WEB_FETCH_TIMEOUT_SECONDS,
			default: DEFAULT_WEB_FETCH_TIMEOUT_SECONDS,
		}),
	),
	proxy: Type.Optional(
		Type.String({
			description: "Optional HTTP or SOCKS proxy URL to pass to Obscura",
			minLength: 1,
			maxLength: MAX_WEB_FETCH_PROXY_LENGTH,
		}),
	),
});

function clampLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit ?? 10)) return 10;
	return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit ?? 10)));
}

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

function decodeHtmlEntities(value: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
	};

	return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (entity, body: string) => {
		if (body[0] === "#") {
			const radix = body[1]?.toLowerCase() === "x" ? 16 : 10;
			const raw = radix === 16 ? body.slice(2) : body.slice(1);
			const codePoint = Number.parseInt(raw, radix);
			if (Number.isFinite(codePoint)) {
				try {
					return String.fromCodePoint(codePoint);
				} catch {
					return entity;
				}
			}
			return entity;
		}

		return named[body.toLowerCase()] ?? entity;
	});
}

function textFromHtml(html: string): string {
	return decodeHtmlEntities(html)
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function getAttribute(tag: string, name: string): string | undefined {
	const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
	const match = tag.match(pattern);
	const raw = match?.[1] ?? match?.[2] ?? match?.[3];
	return raw ? decodeHtmlEntities(raw) : undefined;
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
		redirect: "follow",
		signal: makeSignal(signal, 10_000),
	});

	const finalUrl = new URL(response.url);
	if (finalUrl.hostname !== "html.duckduckgo.com") {
		throw new Error(`DuckDuckGo search redirected to unexpected host: ${finalUrl.hostname}`);
	}

	if (!response.ok) {
		throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`);
	}

	return readDuckDuckGoHtml(response);
}

function normalizeWebFetchUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error(`Invalid URL: ${input}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("web_fetch only supports http:// and https:// URLs");
	}

	return url.href;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function createWebFetchTempDir(): Promise<string> {
	return mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "pi-web-fetch-"));
}

async function readObscuraOutput(outputPath: string): Promise<{ text: string; bytes: number; tooLarge: boolean }> {
	const outputStats = await stat(outputPath);
	if (outputStats.size <= MAX_WEB_FETCH_CAPTURE_BYTES) {
		return {
			text: await readFile(outputPath, "utf8"),
			bytes: outputStats.size,
			tooLarge: false,
		};
	}

	const file = await open(outputPath, "r");
	try {
		const buffer = Buffer.alloc(DEFAULT_MAX_BYTES);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		return {
			text: buffer.subarray(0, bytesRead).toString("utf8"),
			bytes: outputStats.size,
			tooLarge: true,
		};
	} finally {
		await file.close();
	}
}

function makeUtf8PrefixPreview(content: string, maxBytes: number): { content: string; bytes: number } {
	let bytes = 0;
	let endIndex = 0;

	for (const char of content) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (bytes + charBytes > maxBytes) break;
		bytes += charBytes;
		endIndex += char.length;
	}

	return {
		content: content.slice(0, endIndex),
		bytes,
	};
}

export default function (pi: ExtensionAPI) {
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
			const limit = clampLimit(params.limit);
			if (!query) throw new Error("Search query must not be empty");
			if (query.length > MAX_QUERY_LENGTH) {
				throw new Error(`Search query is longer than ${MAX_QUERY_LENGTH} characters`);
			}

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

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch a specific HTTP(S) URL with Obscura. Obscura stealth mode is always enabled. Defaults to markdown output and a ${DEFAULT_WEB_FETCH_WAIT_SECONDS}-second post-navigation settle wait. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first); large or truncated output is saved to a temp file. Binary/raw responses are intentionally not supported by this tool.`,
		promptSnippet:
			"Fetch a specific URL with Obscura stealth mode and return markdown, text, HTML, links, assets, or JavaScript evaluation output.",
		promptGuidelines: [
			"Use web_fetch when the user asks to read, summarize, or extract content from a specific URL.",
			"Use web_search for discovery; use web_fetch only after you have a concrete URL.",
			"Use web_fetch dump=markdown by default. Use dump=text for plain text, dump=html when markup matters, dump=links for page links, and dump=assets for rendered sub-resource URLs.",
			"web_fetch always enables Obscura stealth mode. Do not use web_fetch to bypass logins, paywalls, CAPTCHAs, rate limits, robots restrictions, or other access controls.",
			"When using web_fetch results in an answer about external web content, cite the fetched URL.",
		],
		parameters: webFetchParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<WebFetchDetails>> {
			const url = normalizeWebFetchUrl(params.url);
			const evalScript = normalizeOptionalText(params.eval);
			const selector = normalizeOptionalText(params.selector);
			const proxy = normalizeOptionalText(params.proxy);
			const dump = params.dump ?? DEFAULT_WEB_FETCH_DUMP_MODE;
			const waitUntil = params.waitUntil ?? DEFAULT_WEB_FETCH_WAIT_UNTIL;
			const wait = params.wait ?? DEFAULT_WEB_FETCH_WAIT_SECONDS;
			const timeout = params.timeout ?? DEFAULT_WEB_FETCH_TIMEOUT_SECONDS;

			if (evalScript && params.dump !== undefined) {
				throw new Error("Pass either eval or dump, not both");
			}
			if (evalScript && selector) {
				throw new Error("selector is only supported with dump output; use document.querySelector(...) inside eval");
			}

			const startedAt = Date.now();
			const tempDir = await createWebFetchTempDir();
			const outputPath = join(tempDir, "output.txt");
			let keepTempDir = false;

			try {
				const args = ["fetch", "--quiet", "--stealth"];
				if (evalScript) {
					args.push("--eval", evalScript);
				} else {
					args.push("--dump", dump);
				}
				if (selector) args.push("--selector", selector);
				args.push("--wait-until", waitUntil);
				args.push("--wait", String(wait));
				args.push("--timeout", String(timeout));
				if (proxy) args.push("--proxy", proxy);
				args.push("--output", outputPath, url);

				const processTimeoutMs = (timeout + wait + 10) * 1000;
				const result = await pi.exec("obscura", args, {
					cwd: ctx.cwd,
					signal,
					timeout: processTimeoutMs,
				});

				if (result.killed) {
					throw new Error("obscura fetch was cancelled or timed out");
				}
				if (result.code !== 0) {
					const stderr = result.stderr.trim();
					const stdout = result.stdout.trim();
					throw new Error(
						`obscura fetch failed with exit code ${result.code}: ${stderr || stdout || "no error output"}`,
					);
				}

				let output: { text: string; bytes: number; tooLarge: boolean };
				try {
					output = await readObscuraOutput(outputPath);
				} catch (error) {
					if (!result.stdout) throw error;
					output = {
						text: result.stdout,
						bytes: Buffer.byteLength(result.stdout, "utf8"),
						tooLarge: false,
					};
				}

				const truncation = truncateHead(output.text, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				const firstLinePreview = truncation.firstLineExceedsLimit
					? makeUtf8PrefixPreview(output.text, DEFAULT_MAX_BYTES)
					: undefined;
				const stderr = result.stderr.trim();
				const truncated = output.tooLarge || truncation.truncated;
				keepTempDir = truncated;

				const commonDetails: WebFetchBaseDetails = {
					url,
					waitUntil,
					wait,
					timeout,
					stealth: true,
					proxy: Boolean(proxy),
					elapsedMs: Date.now() - startedAt,
					bytes: output.bytes,
					truncated,
					...(truncation.truncated ? { truncation } : {}),
					...(truncated ? { fullOutputPath: outputPath } : {}),
					...(stderr ? { stderr } : {}),
				};
				const details: WebFetchDetails = evalScript
					? { ...commonDetails, mode: "eval", eval: evalScript }
					: { ...commonDetails, mode: "dump", dump, ...(selector ? { selector } : {}) };

				let text = firstLinePreview?.content ?? truncation.content;
				if (!text) text = "No content returned.";
				if (output.tooLarge) {
					const shownBytes = firstLinePreview?.bytes ?? truncation.outputBytes;
					text += `\n\n[Output truncated: output is ${formatSize(output.bytes)}, which exceeds the ${formatSize(MAX_WEB_FETCH_CAPTURE_BYTES)} in-memory capture limit.`;
					text += ` Showing the first ${formatSize(shownBytes)} available to the tool.`;
					text += ` Full output saved to: ${outputPath}]`;
				} else if (firstLinePreview) {
					text += `\n\n[Output truncated: first line exceeds the ${formatSize(DEFAULT_MAX_BYTES)} output limit.`;
					text += ` Showing the first ${formatSize(firstLinePreview.bytes)} of ${formatSize(truncation.totalBytes)}.`;
					text += ` Full output saved to: ${outputPath}]`;
				} else if (truncation.truncated) {
					text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
					text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
					text += ` Full output saved to: ${outputPath}]`;
				}
				if (stderr) {
					text += `\n\n[Obscura stderr]\n${stderr}`;
				}

				return {
					content: [{ type: "text", text }],
					details,
				};
			} finally {
				if (!keepTempDir) {
					await rm(tempDir, { recursive: true, force: true }).catch(() => {});
				}
			}
		},
	});
}
