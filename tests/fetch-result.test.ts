import assert from "node:assert/strict";
import test from "node:test";
import { createResult as createWebFetchResult } from "../extensions/web-tools/fetch-result.ts";
import type { Request as ObscuraRequest } from "../extensions/web-tools/obscura.ts";
import { scan as scanOutput } from "../extensions/web-tools/output.ts";

const request: ObscuraRequest = {
	mode: "dump",
	dump: "markdown",
	selector: "main",
	url: "https://example.com/docs",
	waitUntil: "load",
	wait: 5,
	timeout: 30,
};

test("formats complete Obscura output without retention details", async () => {
	const output = await scanOutput([Buffer.from("Page content")]);
	const execution = {
		output: { retention: "discard" as const, scan: output },
		stderr: "browser warning",
	};

	const result = createWebFetchResult(request, execution, 42);

	assert.deepEqual(result.content, [{ type: "text", text: "Page content\n\n[Obscura stderr]\nbrowser warning" }]);
	assert.deepEqual(result.details, {
		url: "https://example.com/docs",
		waitUntil: "load",
		wait: 5,
		timeout: 30,
		stealth: true,
		proxy: false,
		elapsedMs: 42,
		bytes: 12,
		truncated: false,
		stderr: "browser warning",
		mode: "dump",
		dump: "markdown",
		selector: "main",
	});
});

test("formats truncated output with its retained file path", async () => {
	const output = await scanOutput([Buffer.from("alpha\nbeta\n")], { maxBytes: 100, maxLines: 1 });
	const execution = {
		output: {
			retention: "retain" as const,
			scan: output,
			fullOutputPath: "/retained/output.txt",
		},
	};

	const result = createWebFetchResult(request, execution, 7);

	assert.deepEqual(result.content, [
		{
			type: "text",
			text: "alpha\n\n[Output truncated: showing 1 of 2 lines (5B of 11B). Full output saved to: /retained/output.txt]",
		},
	]);
	assert.equal(result.details.truncated, true);
	assert.equal(result.details.fullOutputPath, "/retained/output.txt");
});

test("returns a UTF-8 prefix when the first line exceeds the byte limit", async () => {
	const output = await scanOutput([Buffer.from("ééé")], { maxBytes: 5, maxLines: 10 });
	const execution = {
		output: {
			retention: "retain" as const,
			scan: output,
			fullOutputPath: "/retained/output.txt",
		},
	};

	const result = createWebFetchResult(request, execution, 7);

	assert.deepEqual(result.content, [
		{
			type: "text",
			text: "éé\n\n[Output truncated: first line exceeds the 5B output limit. Showing the first 4B of 6B. Full output saved to: /retained/output.txt]",
		},
	]);
});
