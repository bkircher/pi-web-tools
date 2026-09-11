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

const resultHtml = `
	<div class="result">
		<a class="result__a" href="https://example.com/">Example</a>
	</div>
`;

test("web_search serializes parallel requests and spaces their start times", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let markFirstStarted!: () => void;
	const firstStarted = new Promise<void>((resolve) => {
		markFirstStarted = resolve;
	});
	let completeFirst!: (response: Response) => void;
	const firstResponse = new Promise<Response>((resolve) => {
		completeFirst = resolve;
	});
	const responses = [
		() => {
			markFirstStarted();
			return firstResponse;
		},
		async () => new Response(resultHtml, { status: 200 }),
	];
	const fetchMock = context.mock.method(globalThis, "fetch", () => responses.shift()!());
	const tool = getSearchTool();

	const firstResult = tool.execute("first", { query: "first parallel query" }, undefined);
	const secondResult = tool.execute("second", { query: "second parallel query" }, undefined);
	await firstStarted;

	assert.equal(fetchMock.mock.callCount(), 1);
	completeFirst(new Response(resultHtml, { status: 200 }));
	await firstResult;
	await Promise.resolve();
	context.mock.timers.tick(999);
	await Promise.resolve();
	assert.equal(fetchMock.mock.callCount(), 1);
	context.mock.timers.tick(1);
	await secondResult;
	assert.equal(fetchMock.mock.callCount(), 2);
});
