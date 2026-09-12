import assert from "node:assert/strict";
import test from "node:test";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Execution } from "../extensions/web-tools/obscura.ts";
import { scan as scanOutput } from "../extensions/web-tools/output.ts";
import { registerTool, type SearchParameters } from "../extensions/web-tools/search.ts";
import type { RunObscura } from "../extensions/web-tools/search-obscura.ts";
import type { Details } from "../extensions/web-tools/search-types.ts";

type SearchTool = {
	execute(
		toolCallId: string,
		params: SearchParameters,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<Details> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Details>>;
};

const toolContext = { cwd: "/project" } as ExtensionContext;

function getSearchTool(runObscura: RunObscura): SearchTool {
	let tool: SearchTool | undefined;
	registerTool(
		{
			registerTool(definition: SearchTool) {
				tool = definition;
			},
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		} as unknown as ExtensionAPI,
		{ runObscura },
	);
	assert.ok(tool);
	return tool;
}

async function createExecution(title = "Example", href = "https://example.com/"): Promise<Execution> {
	const text = JSON.stringify({
		pageUrl: "https://html.duckduckgo.com/html/?q=example",
		challenge: false,
		results: [{ title, href }],
	});
	const scan = await scanOutput([Buffer.from(text)]);
	return { output: { retention: "discard", scan } };
}

test("web_search keeps cache state within each registration", async () => {
	const firstExecution = await createExecution("First registration", "https://example.com/first");
	const secondExecution = await createExecution("Second registration", "https://example.com/second");
	let firstCalls = 0;
	let secondCalls = 0;
	const firstTool = getSearchTool(async () => {
		firstCalls += 1;
		return firstExecution;
	});
	const secondTool = getSearchTool(async () => {
		secondCalls += 1;
		return secondExecution;
	});
	const query = { query: "registration cache isolation query" };

	const first = await firstTool.execute("first", query, undefined, undefined, toolContext);
	const second = await secondTool.execute("second", query, undefined, undefined, toolContext);
	const firstCached = await firstTool.execute("first-cached", query, undefined, undefined, toolContext);
	const secondCached = await secondTool.execute("second-cached", query, undefined, undefined, toolContext);

	assert.equal(firstCalls, 1);
	assert.equal(secondCalls, 1);
	assert.equal(first.details?.cached, false);
	assert.equal(second.details?.cached, false);
	assert.equal(firstCached.details?.cached, true);
	assert.equal(secondCached.details?.cached, true);
	assert.equal(first.details?.results[0]?.title, "First registration");
	assert.equal(second.details?.results[0]?.title, "Second registration");
	assert.equal(firstCached.details?.results[0]?.title, "First registration");
	assert.equal(secondCached.details?.results[0]?.title, "Second registration");
});

test("web_search serializes registrations and spaces their start times", async (context) => {
	const execution = await createExecution();
	context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	const { promise: firstStarted, resolve: markFirstStarted } = Promise.withResolvers<void>();
	const { promise: firstExecution, resolve: completeFirst } = Promise.withResolvers<Execution>();
	let firstCalls = 0;
	let secondCalls = 0;
	const firstTool = getSearchTool(async () => {
		firstCalls += 1;
		markFirstStarted();
		return firstExecution;
	});
	const secondTool = getSearchTool(async () => {
		secondCalls += 1;
		return execution;
	});
	const query = { query: "parallel registration query" };

	const firstResult = firstTool.execute("first", query, undefined, undefined, toolContext);
	const secondResult = secondTool.execute("second", query, undefined, undefined, toolContext);
	await firstStarted;

	assert.equal(firstCalls, 1);
	assert.equal(secondCalls, 0);
	completeFirst(execution);
	await firstResult;
	await Promise.resolve();
	context.mock.timers.tick(999);
	await Promise.resolve();
	assert.equal(secondCalls, 0);
	context.mock.timers.tick(1);
	await secondResult;
	assert.equal(secondCalls, 1);
});

test("web_search reuses a queued response from the cache", async (context) => {
	const execution = await createExecution();
	context.mock.timers.enable({ apis: ["Date"], now: 2000 });
	const { promise: firstExecution, resolve: completeFirst } = Promise.withResolvers<Execution>();
	let calls = 0;
	const runObscura: RunObscura = async () => {
		calls += 1;
		return firstExecution;
	};
	const tool = getSearchTool(runObscura);

	const firstResult = tool.execute("first", { query: "queued cache reuse query" }, undefined, undefined, toolContext);
	const secondResult = tool.execute(
		"second",
		{ query: "queued cache reuse query" },
		undefined,
		undefined,
		toolContext,
	);
	await Promise.resolve();
	completeFirst(execution);
	const first = await firstResult;
	const second = await secondResult;

	assert.equal(calls, 1);
	assert.equal(first.details?.cached, false);
	assert.equal(second.details?.cached, true);
});
