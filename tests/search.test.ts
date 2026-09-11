import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTool, type SearchParameters } from "../extensions/web-tools/search.ts";
import type { Details } from "../extensions/web-tools/search-types.ts";

type SearchTool = {
	execute(
		toolCallId: string,
		params: SearchParameters,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<Details>>;
};

function getSearchTool(): SearchTool {
	let tool: SearchTool | undefined;
	registerTool({
		registerTool(definition: SearchTool) {
			tool = definition;
		},
	} as unknown as ExtensionAPI);
	assert.ok(tool);
	return tool;
}

test("web_search reports a DuckDuckGo anti-bot challenge", async (context) => {
	context.mock.method(globalThis, "fetch", async () => new Response("challenge", { status: 202 }));
	const tool = getSearchTool();

	const result = tool.execute("anti-bot-challenge", { query: "challenge test" }, undefined);

	await assert.rejects(result, {
		message: "DuckDuckGo blocked the search with an anti-bot challenge (HTTP 202)",
	});
});

test("web_search reports the network error code hidden by fetch", async (context) => {
	const cause = Object.assign(new Error("getaddrinfo ENOTFOUND html.duckduckgo.com"), { code: "ENOTFOUND" });
	context.mock.method(globalThis, "fetch", async () => {
		throw new TypeError("fetch failed", { cause });
	});
	const tool = getSearchTool();

	const result = tool.execute("network-error", { query: "network error test" }, undefined);

	await assert.rejects(result, {
		message: "DuckDuckGo request failed before an HTTP response: fetch failed (ENOTFOUND)",
	});
});

test("web_search reports a timeout separately", async (context) => {
	const timeoutController = new AbortController();
	timeoutController.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
	context.mock.method(AbortSignal, "timeout", () => timeoutController.signal);
	context.mock.method(globalThis, "fetch", async () => {
		throw timeoutController.signal.reason;
	});
	const tool = getSearchTool();

	const result = tool.execute("timeout", { query: "timeout test" }, undefined);

	await assert.rejects(result, { message: "DuckDuckGo search timed out after 10 seconds" });
});

test("web_search reports cancellation separately", async (context) => {
	const cancellationController = new AbortController();
	cancellationController.abort(new DOMException("The operation was aborted", "AbortError"));
	const timeoutController = new AbortController();
	context.mock.method(AbortSignal, "timeout", () => timeoutController.signal);
	context.mock.method(globalThis, "fetch", async () => {
		throw cancellationController.signal.reason;
	});
	const tool = getSearchTool();

	const result = tool.execute("cancellation", { query: "cancellation test" }, cancellationController.signal);

	await assert.rejects(result, { message: "DuckDuckGo search was cancelled" });
});
