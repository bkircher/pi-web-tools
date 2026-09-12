import { setTimeout as delay } from "node:timers/promises";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { MAX_RESULTS } from "./duckduckgo.js";
import { renderSearchCall, renderSearchResult } from "./render.js";
import { searchDuckDuckGo, type RunObscura } from "./search-obscura.js";
import type { Details, ResponseData, Result } from "./search-types.js";

type CacheEntry = {
	expiresAt: number;
	response: ResponseData;
};

type SearchCache = Map<string, CacheEntry>;

type CachedResponse = {
	response: ResponseData;
	cached: boolean;
};

type SearchToolOptions = {
	runObscura?: RunObscura;
};

const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const MAX_QUERY_LENGTH = 500;
const MIN_QUEUED_SEARCH_INTERVAL_MS = 1000;

function createCancellationError(): Error {
	return new Error("DuckDuckGo search was cancelled");
}

function raceWithCancellation<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return operation;

	const { promise: cancellation, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(createCancellationError());
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();

	return Promise.race([operation, cancellation]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

let searchQueue: Promise<void> = Promise.resolve();
let activeOrQueuedSearches = 0;
let lastSearchStartedAt = 0;

const parameters = Type.Object({
	query: Type.String({
		description: "Search query to send to DuckDuckGo HTML search",
		minLength: 1,
		maxLength: MAX_QUERY_LENGTH,
	}),
	limit: Type.Optional(
		Type.Integer({
			description: `Maximum number of search results to return (1-${MAX_RESULTS}, default 10)`,
			minimum: 1,
			maximum: MAX_RESULTS,
		}),
	),
});

export type SearchParameters = Static<typeof parameters>;

type SearchExecutionContext = Pick<ExtensionContext, "cwd">;
type SearchToolDefinition = ToolDefinition<typeof parameters, Details>;

export type SearchTool = Omit<SearchToolDefinition, "execute"> & {
	execute(
		toolCallId: string,
		params: SearchParameters,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<Details> | undefined,
		context: SearchExecutionContext,
	): Promise<AgentToolResult<Details>>;
};

type SearchExtensionAPI = Pick<ExtensionAPI, "exec"> & {
	registerTool(tool: SearchTool): void;
};

function cacheKey(query: string): string {
	return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function getCached(cache: SearchCache, query: string): ResponseData | undefined {
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
	return entry.response;
}

function setCached(cache: SearchCache, query: string, response: ResponseData): void {
	cache.set(cacheKey(query), {
		expiresAt: Date.now() + CACHE_TTL_MS,
		response,
	});

	while (cache.size > MAX_CACHE_ENTRIES) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey === undefined) break;
		cache.delete(oldestKey);
	}
}

function getSearchResponse(
	cache: SearchCache,
	query: string,
	signal: AbortSignal | undefined,
	load: () => Promise<ResponseData>,
): Promise<CachedResponse> {
	const cachedResponse = getCached(cache, query);
	if (cachedResponse) return Promise.resolve({ response: cachedResponse, cached: true });

	const mustWaitForInterval = activeOrQueuedSearches > 0;
	activeOrQueuedSearches += 1;

	const queuedResult = searchQueue.then(async () => {
		if (signal?.aborted) throw createCancellationError();

		const queuedResponse = getCached(cache, query);
		if (queuedResponse) return { response: queuedResponse, cached: true };

		if (mustWaitForInterval) {
			const waitMs = Math.max(0, lastSearchStartedAt + MIN_QUEUED_SEARCH_INTERVAL_MS - Date.now());
			if (waitMs > 0) await delay(waitMs, undefined, { signal });
			if (signal?.aborted) throw createCancellationError();
		}

		lastSearchStartedAt = Date.now();
		const response = await load();
		setCached(cache, query, response);
		return { response, cached: false };
	});

	searchQueue = queuedResult
		.then(() => undefined)
		.finally(() => {
			activeOrQueuedSearches -= 1;
		})
		.catch(() => undefined);
	return raceWithCancellation(queuedResult, signal);
}

function formatResults(results: Result[]): string {
	return results
		.map((result, index) => {
			const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`];
			if (result.snippet) lines.push(`   ${result.snippet}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

/**
 * Register the `web_search` tool, which searches DuckDuckGo through Obscura.
 */
export function registerTool(pi: SearchExtensionAPI, options: SearchToolOptions = {}): void {
	const cache: SearchCache = new Map();

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using DuckDuckGo HTML search through Obscura. Returns result titles, URLs, and snippets; does not fetch result pages.",
		promptSnippet: "Search the web with DuckDuckGo through Obscura and return titles, URLs, and snippets.",
		promptGuidelines: [
			"Use web_search when the user asks for current or external web information that is not available in the repository.",
			"When using web_search results in an answer, cite the relevant result URLs.",
		],
		parameters,

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<Details>> {
			const query = params.query.trim();
			const limit = params.limit ?? 10;
			if (!query) throw new Error("Search query must not be empty");

			const startedAt = Date.now();
			const { response, cached } = await getSearchResponse(cache, query, signal, () =>
				searchDuckDuckGo(query, {
					exec: (command, args, executeOptions) => pi.exec(command, args, executeOptions),
					cwd: ctx.cwd,
					signal,
					runObscura: options.runObscura,
				}),
			);
			const results = response.results.slice(0, limit);
			const details: Details = {
				...response,
				query,
				limit,
				cached,
				elapsedMs: Date.now() - startedAt,
				results,
			};

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: "No search results found." }],
					details,
				};
			}

			return {
				content: [{ type: "text", text: formatResults(results) }],
				details,
			};
		},

		renderCall: renderSearchCall,
		renderResult: renderSearchResult,
	});
}
