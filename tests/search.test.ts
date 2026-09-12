import assert from "node:assert/strict";
import test from "node:test";
import { ObscuraError, type Exec } from "../extensions/web-tools/obscura.ts";
import { searchDuckDuckGo, type RunObscura } from "../extensions/web-tools/search-obscura.ts";
import { scan as scanOutput } from "../extensions/web-tools/output.ts";

const unusedExec: Exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });

const validEvaluation = {
	pageUrl: "https://html.duckduckgo.com/html/?q=example",
	challenge: false,
	results: [{ title: "Example", href: "https://example.com/", snippet: "Example page" }],
};

async function createExecution(value: unknown, stderr?: string) {
	const scan = await scanOutput([Buffer.from(JSON.stringify(value))]);
	return {
		output: { retention: "discard" as const, scan: { ...scan, bytes: 321 } },
		...(stderr ? { stderr } : {}),
	};
}

async function createTextExecution(text: string) {
	const scan = await scanOutput([Buffer.from(text)]);
	return { output: { retention: "discard" as const, scan } };
}

test("searches with a fixed Obscura evaluation and normalizes results", async () => {
	let capturedRequest: Parameters<RunObscura>[0] | undefined;
	let capturedOptions: Parameters<RunObscura>[1] | undefined;
	const execution = await createExecution(
		{
			pageUrl: "https://html.duckduckgo.com/html/?q=fixed-evaluation-test",
			challenge: false,
			results: [
				{
					title: "  Example \n Docs ",
					href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs",
					snippet: " Read\tmore ",
				},
				{ title: "Duplicate", href: "https://example.com/docs" },
				{ title: "Unsafe", href: "javascript:alert(1)" },
			],
		},
		"browser warning",
	);
	const runObscura: RunObscura = async (request, options) => {
		capturedRequest = request;
		capturedOptions = options;
		return execution;
	};

	const response = await searchDuckDuckGo("fixed evaluation test", {
		exec: unusedExec,
		cwd: "/project",
		runObscura,
	});

	assert.deepEqual(response, {
		backend: "obscura",
		searchUrl: "https://html.duckduckgo.com/html/?q=fixed+evaluation+test&kl=wt-wt&kp=-1",
		bytes: 321,
		results: [{ title: "Example Docs", url: "https://example.com/docs", snippet: "Read more" }],
		stderr: "browser warning",
	});
	assert.ok(capturedRequest?.mode === "eval");
	assert.equal(capturedRequest.url, "https://html.duckduckgo.com/html/?q=fixed+evaluation+test&kl=wt-wt&kp=-1");
	assert.equal(capturedRequest.waitUntil, "domcontentloaded");
	assert.equal(capturedRequest.wait, 0);
	assert.equal(capturedRequest.timeout, 10);
	assert.equal(capturedRequest.script.includes("fixed evaluation test"), false);
	assert.equal(capturedOptions?.cwd, "/project");
	assert.equal(capturedOptions?.exec, unusedExec);
});

test("reports a DuckDuckGo anti-bot challenge", async () => {
	const execution = await createExecution({ ...validEvaluation, challenge: true });
	const runObscura: RunObscura = async () => execution;

	const result = searchDuckDuckGo("challenge test", {
		exec: unusedExec,
		cwd: "/project",
		runObscura,
	});

	await assert.rejects(result, {
		message: "DuckDuckGo blocked the search with an anti-bot challenge",
	});
});

test("rejects malformed Obscura output", async () => {
	const execution = await createTextExecution("not JSON");
	const runObscura: RunObscura = async () => execution;

	const result = searchDuckDuckGo("malformed output test", {
		exec: unusedExec,
		cwd: "/project",
		runObscura,
	});

	await assert.rejects(result, {
		message: "DuckDuckGo search failed through Obscura: Obscura returned invalid JSON",
	});
});

test("rejects truncated Obscura output", async () => {
	const scan = await scanOutput([Buffer.from(JSON.stringify(validEvaluation))], { maxBytes: 10 });
	const execution = {
		output: { retention: "retain" as const, scan, fullOutputPath: "/retained/output.txt" },
	};
	const runObscura: RunObscura = async () => execution;

	const result = searchDuckDuckGo("truncated output test", {
		exec: unusedExec,
		cwd: "/project",
		runObscura,
	});

	await assert.rejects(result, {
		message: "DuckDuckGo search failed through Obscura: Obscura returned truncated evaluation output",
	});
});

test("rejects an unexpected final host", async () => {
	const execution = await createExecution({ ...validEvaluation, pageUrl: "https://evil.example/search" });
	const runObscura: RunObscura = async () => execution;

	const result = searchDuckDuckGo("final host test", {
		exec: unusedExec,
		cwd: "/project",
		runObscura,
	});

	await assert.rejects(result, {
		message: "DuckDuckGo search failed through Obscura: Obscura returned an unexpected final host: evil.example",
	});
});

test("rejects invalid structured result fields", async () => {
	const execution = await createExecution({
		...validEvaluation,
		results: [{ title: "Example", href: 42 }],
	});
	const runObscura: RunObscura = async () => execution;

	const result = searchDuckDuckGo("invalid fields test", {
		exec: unusedExec,
		cwd: "/project",
		runObscura,
	});

	await assert.rejects(result, {
		message: "DuckDuckGo search failed through Obscura: Obscura returned invalid search result fields",
	});
});

test("reports an Obscura timeout separately", async () => {
	const runObscura: RunObscura = async () => {
		throw new ObscuraError("timeout", "obscura fetch timed out");
	};

	const result = searchDuckDuckGo("timeout test", {
		exec: unusedExec,
		cwd: "/project",
		runObscura,
	});

	await assert.rejects(result, { message: "DuckDuckGo search timed out after 10 seconds" });
});

test("does not infer a timeout from command failure text", async () => {
	const runObscura: RunObscura = async () => {
		throw new ObscuraError("command-failed", "obscura fetch failed with exit code 2: invalid timeout argument");
	};

	const result = searchDuckDuckGo("invalid timeout argument test", {
		exec: unusedExec,
		cwd: "/project",
		runObscura,
	});

	await assert.rejects(result, {
		message:
			"DuckDuckGo search failed through Obscura: obscura fetch failed with exit code 2: invalid timeout argument",
	});
});

test("reports cancellation separately", async () => {
	const controller = new AbortController();
	const runObscura: RunObscura = async () => {
		controller.abort();
		throw new DOMException("The operation was aborted", "AbortError");
	};

	const result = searchDuckDuckGo("cancellation test", {
		exec: unusedExec,
		cwd: "/project",
		signal: controller.signal,
		runObscura,
	});

	await assert.rejects(result, { message: "DuckDuckGo search was cancelled" });
});

test("reports a command failure without retrying", async () => {
	let calls = 0;
	const runObscura: RunObscura = async () => {
		calls += 1;
		throw new Error("obscura fetch failed with exit code 2: navigation failed");
	};

	const result = searchDuckDuckGo("command failure test", {
		exec: unusedExec,
		cwd: "/project",
		runObscura,
	});

	await assert.rejects(result, {
		message: "DuckDuckGo search failed through Obscura: obscura fetch failed with exit code 2: navigation failed",
	});
	assert.equal(calls, 1);
});
