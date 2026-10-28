import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { searchDuckDuckGo, type RunObscura } from "../extensions/web-tools/search/execute.ts";
import type { Exec } from "../extensions/web-tools/shared/obscura.ts";
import { scan } from "../extensions/web-tools/shared/output.ts";

const unusedExec: Exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });

const resultLink = {
	textContent: " Example ",
	getAttribute: () => "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F",
	closest: () => ({ querySelector: () => ({ textContent: " Example page " }) }),
};

function evaluatePage(document: object): RunObscura {
	return async (request) => {
		assert.ok(request.mode === "eval");
		const value = runInNewContext(request.script, {
			document,
			location: { href: request.url },
		});
		const output = await scan([Buffer.from(JSON.stringify(value))]);
		assert.equal(output.truncated, false);
		return { output };
	};
}

test("extracts search results from the rendered page", async () => {
	const document = {
		querySelector: () => null,
		querySelectorAll: () => [resultLink],
	};

	const response = await searchDuckDuckGo("example", {
		exec: unusedExec,
		cwd: "/project",
		runObscura: evaluatePage(document),
	});

	assert.deepEqual(response.results, [{ title: "Example", url: "https://example.com/", snippet: "Example page" }]);
});

test("extracts search results without a snippet", async () => {
	const document = {
		querySelector: () => null,
		querySelectorAll: () => [{ ...resultLink, closest: () => null }],
	};

	const response = await searchDuckDuckGo("example", {
		exec: unusedExec,
		cwd: "/project",
		runObscura: evaluatePage(document),
	});

	assert.deepEqual(response.results, [{ title: "Example", url: "https://example.com/" }]);
});

test("returns no results when the rendered page has no result links", async () => {
	const document = {
		querySelector: () => null,
		querySelectorAll: () => [],
	};

	const response = await searchDuckDuckGo("example", {
		exec: unusedExec,
		cwd: "/project",
		runObscura: evaluatePage(document),
	});

	assert.deepEqual(response.results, []);
});

test("extracts at most 20 results from the rendered page", async () => {
	const urls = [
		"https://example.com/1",
		"https://example.com/2",
		"https://example.com/3",
		"https://example.com/4",
		"https://example.com/5",
		"https://example.com/6",
		"https://example.com/7",
		"https://example.com/8",
		"https://example.com/9",
		"https://example.com/10",
		"https://example.com/11",
		"https://example.com/12",
		"https://example.com/13",
		"https://example.com/14",
		"https://example.com/15",
		"https://example.com/16",
		"https://example.com/17",
		"https://example.com/18",
		"https://example.com/19",
		"https://example.com/20",
		"https://example.com/21",
	];
	const links = urls.map((url) => ({ ...resultLink, getAttribute: () => url }));
	const document = {
		querySelector: () => null,
		querySelectorAll: () => links,
	};

	const response = await searchDuckDuckGo("example", {
		exec: unusedExec,
		cwd: "/project",
		runObscura: evaluatePage(document),
	});

	assert.equal(response.results.length, 20);
	assert.deepEqual(response.results.at(-1), {
		title: "Example",
		url: "https://example.com/20",
		snippet: "Example page",
	});
});

test("rejects a rendered challenge page", async () => {
	const elements = new Map([
		["#challenge-form, .anomaly-modal__modal, .anomaly-modal__challenge, form[action*='anomaly.js']", {}],
	]);
	const document = {
		querySelector: (selector: string) => elements.get(selector) ?? null,
		querySelectorAll: () => [],
	};

	const result = searchDuckDuckGo("example", {
		exec: unusedExec,
		cwd: "/project",
		runObscura: evaluatePage(document),
	});

	await assert.rejects(result, { message: "DuckDuckGo blocked the search with an anti-bot challenge" });
});
