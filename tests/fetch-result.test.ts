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
	assert.equal(output.truncated, false);
	const execution = {
		output,
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

test("limits stderr as part of the returned tool output", async () => {
	const output = await scanOutput([Buffer.from("Page content")]);
	assert.equal(output.truncated, false);
	const execution = {
		output,
		stderr: "a".repeat(100_000),
	};

	const result = createWebFetchResult(request, execution, 42);
	const content = result.content[0];

	assert.ok(content?.type === "text");
	assert.equal(Buffer.byteLength(content.text, "utf8"), 51_200);
	assert.match(content.text, /\[Tool output truncated: 2000-line or 50\.0KB limit reached\.\]$/u);
	assert.equal(result.details.truncated, true);
	assert.equal(Buffer.byteLength(result.details.stderr ?? "", "utf8"), 51_200);
	assert.match(result.details.stderr ?? "", /\[Obscura stderr truncated: 2000-line or 50\.0KB limit reached\.\]$/u);
});

test("limits stderr by the total tool output line count", async () => {
	const output = await scanOutput([Buffer.from("Page content")]);
	assert.equal(output.truncated, false);
	const execution = {
		output,
		stderr: "warning\n".repeat(3_000),
	};

	const result = createWebFetchResult(request, execution, 42);
	const content = result.content[0];

	assert.ok(content?.type === "text");
	assert.equal(content.text.split("\n").length, 2_000);
	assert.match(content.text, /\[Tool output truncated: 2000-line or 50\.0KB limit reached\.\]$/u);
	assert.equal(result.details.truncated, true);
});

test("formats truncated output with its retained file path", async () => {
	const output = await scanOutput([Buffer.from("alpha\nbeta\n")], { maxBytes: 100, maxLines: 1 });
	assert.equal(output.truncated, true);
	const execution = {
		output: {
			...output,
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
	assert.equal(output.truncated, true);
	const execution = {
		output: {
			...output,
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
