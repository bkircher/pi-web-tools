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

async function createExecution(): Promise<Execution> {
	const text = JSON.stringify({
		pageUrl: "https://html.duckduckgo.com/html/?q=example",
		challenge: false,
		results: [{ title: "Example", href: "https://example.com/" }],
	});
	const scan = await scanOutput([Buffer.from(text)]);
	return { output: { retention: "discard", scan } };
}

test("web_search serializes parallel requests and spaces their start times", async (context) => {
	const execution = await createExecution();
	context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let markFirstStarted!: () => void;
	const firstStarted = new Promise<void>((resolve) => {
		markFirstStarted = resolve;
	});
	let completeFirst!: (execution: Execution) => void;
	const firstExecution = new Promise<Execution>((resolve) => {
		completeFirst = resolve;
	});
	const executions = [firstExecution, Promise.resolve(execution)];
	let calls = 0;
	const runObscura: RunObscura = async () => {
		markFirstStarted();
		const nextExecution = executions[calls];
		calls += 1;
		return nextExecution!;
	};
	const tool = getSearchTool(runObscura);

	const firstResult = tool.execute(
		"first",
		{ query: "first parallel Obscura query" },
		undefined,
		undefined,
		toolContext,
	);
	const secondResult = tool.execute(
		"second",
		{ query: "second parallel Obscura query" },
		undefined,
		undefined,
		toolContext,
	);
	await firstStarted;

	assert.equal(calls, 1);
	completeFirst(execution);
	await firstResult;
	await Promise.resolve();
	context.mock.timers.tick(999);
	await Promise.resolve();
	assert.equal(calls, 1);
	context.mock.timers.tick(1);
	await secondResult;
	assert.equal(calls, 2);
});

test("web_search reuses a queued response from the cache", async (context) => {
	const execution = await createExecution();
	context.mock.timers.enable({ apis: ["Date"], now: 2000 });
	let completeFirst!: (execution: Execution) => void;
	const firstExecution = new Promise<Execution>((resolve) => {
		completeFirst = resolve;
	});
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
