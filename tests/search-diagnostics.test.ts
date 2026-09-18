import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import type { Exec, Execution } from "../extensions/web-tools/obscura.ts";
import { scan } from "../extensions/web-tools/output.ts";
import { registerTool, type SearchTool } from "../extensions/web-tools/search.ts";
import type { DiagnosticStorage } from "../extensions/web-tools/search-diagnostics.ts";
import { buildSearchEvaluationScript } from "../extensions/web-tools/search-evaluation.ts";
import { searchDuckDuckGo, type RunObscura } from "../extensions/web-tools/search-obscura.ts";

const pageUrl = "https://html.duckduckgo.com/html/?q=example";
const challengeMessage = "DuckDuckGo blocked the search with an anti-bot challenge";
const combinedSelector =
	"#challenge-form, .anomaly-modal__modal, .anomaly-modal__challenge, form[action*='anomaly.js']";
const element = { outerHTML: '<form id="challenge-form">Verify this search</form>' };
const challengeElements = new Map([
	[combinedSelector, element],
	["#challenge-form", element],
]);
const resultLink = {
	textContent: "Example",
	getAttribute: () => "https://example.com/",
	closest: () => ({ querySelector: () => ({ textContent: "Example page" }) }),
};

function page(elements = challengeElements) {
	return {
		title: "DuckDuckGo",
		readyState: "interactive",
		body: { textContent: "Verify this search" },
		querySelector: (selector: string) => elements.get(selector) ?? null,
		querySelectorAll: () => [resultLink],
	};
}

function evaluate(document = page(), diagnostics = true, url = pageUrl) {
	// Round-trip JSON as the CLI does, to remove VM-specific object prototypes.
	return JSON.parse(
		JSON.stringify(runInNewContext(buildSearchEvaluationScript(diagnostics), { document, location: { href: url } })),
	);
}

function setup(context: TestContext, document = page(), stderr = "browser log") {
	context.mock.timers.enable({ apis: ["Date"], now: 0 });
	const files = new Map<string, string>();
	const storage = {
		createDirectory: context.mock.fn(async () => "/reports/search-1"),
		writeFile: context.mock.fn<DiagnosticStorage["writeFile"]>(async (path, content) => {
			files.set(path, content);
		}),
		removeDirectory: context.mock.fn(async (_path: string) => undefined),
	} satisfies DiagnosticStorage;
	const exec = context.mock.fn<Exec>(async () => ({
		stdout: "obscura 0.1.0-test\n",
		stderr: "",
		code: 0,
		killed: false,
	}));
	const runObscura = context.mock.fn<RunObscura>(async (request): Promise<Execution> => {
		assert.equal(request.mode, "eval");
		assert.ok(request.mode === "eval");
		const value = runInNewContext(request.script, { document, location: { href: pageUrl } });
		const output = await scan([Buffer.from(JSON.stringify(value))]);
		assert.equal(output.truncated, false);
		return { output, stderr };
	});
	return {
		files,
		storage,
		exec,
		runObscura,
		options: { exec, runObscura, cwd: "/project", diagnostics: true, diagnosticStorage: storage },
	};
}

test("retains challenge evidence from one navigation and returns only its path", async (context) => {
	const { options, files, storage, exec, runObscura } = setup(context);

	const result = searchDuckDuckGo("example", options);

	await assert.rejects(result, { message: `${challengeMessage}\nDiagnostic report: /reports/search-1` });
	assert.equal(runObscura.mock.callCount(), 1);
	assert.equal(runObscura.mock.calls[0].arguments[0].verbose, true);
	assert.equal(exec.mock.callCount(), 1);
	assert.deepEqual(exec.mock.calls[0].arguments, [
		"obscura",
		["--version"],
		{ cwd: "/project", signal: undefined, timeout: 2000 },
	]);
	assert.deepEqual(JSON.parse(files.get("/reports/search-1/report.json")!), {
		schemaVersion: 1,
		capturedAt: "1970-01-01T00:00:00.000Z",
		query: "example",
		searchUrl: "https://html.duckduckgo.com/html/?q=example&kl=wt-wt&kp=-1",
		navigation: { waitUntil: "domcontentloaded", wait: 0, timeout: 10, stealth: true, verbose: true },
		obscura: { command: "obscura", version: "obscura 0.1.0-test" },
		page: {
			challenge: true,
			url: "https://html.duckduckgo.com/html/?q=example",
			pageUrlTruncated: false,
			title: { text: "DuckDuckGo", truncated: false },
			readyState: { text: "interactive", truncated: false },
			resultCount: 1,
			matches: [{ selector: "#challenge-form", htmlTruncated: false }],
			pageText: { text: "Verify this search", truncated: false },
		},
		stderrTruncated: false,
	});
	assert.equal(
		files.get("/reports/search-1/challenge.html"),
		'<!-- Selector: #challenge-form; truncated: false -->\n<form id="challenge-form">Verify this search</form>\n',
	);
	assert.equal(files.get("/reports/search-1/stderr.txt"), "browser log");
	assert.equal(files.size, 3);
	assert.equal(storage.createDirectory.mock.callCount(), 1);
	assert.equal(storage.removeDirectory.mock.callCount(), 0);
	assert.deepEqual(
		storage.writeFile.mock.calls.map((call) => call.arguments[2]),
		[
			{ mode: 0o600, flag: "wx" },
			{ mode: 0o600, flag: "wx" },
			{ mode: 0o600, flag: "wx" },
		],
	);
});

test("does not capture or retain evidence when diagnostics are disabled", async (context) => {
	const { options, files, storage, exec, runObscura } = setup(context);

	const result = searchDuckDuckGo("example", { ...options, diagnostics: false });

	await assert.rejects(result, { message: challengeMessage });
	assert.equal(runObscura.mock.callCount(), 1);
	assert.equal(runObscura.mock.calls[0].arguments[0].verbose, undefined);
	assert.equal(exec.mock.callCount(), 0);
	assert.equal(storage.createDirectory.mock.callCount(), 0);
	assert.equal(files.size, 0);
	assert.equal(evaluate(page(), false).evidence, undefined);
});

test("successful searches leave no reports and do not return verbose logs", async (context) => {
	const { options, files, storage, exec, runObscura } = setup(context, page(new Map()));

	const result = await searchDuckDuckGo("example", options);

	assert.deepEqual(result.results, [{ title: "Example", url: "https://example.com/", snippet: "Example page" }]);
	assert.equal(result.stderr, undefined);
	assert.equal(runObscura.mock.callCount(), 1);
	assert.equal(exec.mock.callCount(), 0);
	assert.equal(storage.createDirectory.mock.callCount(), 0);
	assert.equal(files.size, 0);
});

test("empty successful searches leave no reports", async (context) => {
	const document = { ...page(new Map()), querySelectorAll: () => [] };
	const { options, files, storage } = setup(context, document);

	const result = await searchDuckDuckGo("example", options);

	assert.deepEqual(result.results, []);
	assert.equal(storage.createDirectory.mock.callCount(), 0);
	assert.equal(files.size, 0);
});

test("a report-directory failure keeps the challenge error without a retry", async (context) => {
	const { options, storage, runObscura } = setup(context);
	storage.createDirectory.mock.mockImplementation(async () => {
		throw new Error("permission denied");
	});

	const result = searchDuckDuckGo("example", options);

	await assert.rejects(result, { message: `${challengeMessage}\nDiagnostic report could not be saved.` });
	assert.equal(runObscura.mock.callCount(), 1);
	assert.equal(storage.writeFile.mock.callCount(), 0);
	assert.equal(storage.removeDirectory.mock.callCount(), 0);
});

test("a file-write failure removes the incomplete report and keeps the challenge error", async (context) => {
	const { options, storage, runObscura } = setup(context);
	storage.writeFile.mock.mockImplementationOnce(async () => {
		throw new Error("disk full");
	}, 1);

	const result = searchDuckDuckGo("example", options);

	await assert.rejects(result, { message: `${challengeMessage}\nDiagnostic report could not be saved.` });
	assert.equal(runObscura.mock.callCount(), 1);
	assert.equal(storage.writeFile.mock.callCount(), 2);
	assert.deepEqual(storage.removeDirectory.mock.calls[0].arguments, ["/reports/search-1"]);
});

test("a version-command failure does not prevent saving page evidence", async (context) => {
	const { options, files, exec } = setup(context);
	exec.mock.mockImplementation(async () => {
		throw new Error("version command failed");
	});

	const result = searchDuckDuckGo("example", options);

	await assert.rejects(result, { message: `${challengeMessage}\nDiagnostic report: /reports/search-1` });
	assert.equal(JSON.parse(files.get("/reports/search-1/report.json")!).obscura.version, null);
	assert.equal(files.size, 3);
});

test("a timed-out version command does not prevent saving page evidence", async (context) => {
	const { options, files, exec } = setup(context);
	exec.mock.mockImplementation(async () => ({ stdout: "partial", stderr: "", code: 1, killed: true }));

	const result = searchDuckDuckGo("example", options);

	await assert.rejects(result, { message: `${challengeMessage}\nDiagnostic report: /reports/search-1` });
	assert.equal(JSON.parse(files.get("/reports/search-1/report.json")!).obscura.version, null);
});

test("stderr evidence respects the byte limit and records truncation", async (context) => {
	const { options, files } = setup(context, page(), "🙂".repeat(20_000));

	const result = searchDuckDuckGo("example", options);

	await assert.rejects(result, { message: `${challengeMessage}\nDiagnostic report: /reports/search-1` });
	const stderr = files.get("/reports/search-1/stderr.txt")!;
	assert.ok(Buffer.byteLength(stderr) <= 51_200);
	assert.match(stderr, /\[Obscura stderr truncated: 2000-line or 50\.0KB limit reached\.\]$/u);
	assert.equal(JSON.parse(files.get("/reports/search-1/report.json")!).stderrTruncated, true);
});

test("stderr evidence respects the line limit", async (context) => {
	const { options, files } = setup(context, page(), "log\n".repeat(2100));

	const result = searchDuckDuckGo("example", options);

	await assert.rejects(result, { message: `${challengeMessage}\nDiagnostic report: /reports/search-1` });
	assert.equal(files.get("/reports/search-1/stderr.txt")!.split("\n").length, 2000);
	assert.equal(JSON.parse(files.get("/reports/search-1/report.json")!).stderrTruncated, true);
});

test("page-capture failures preserve the challenge error", async (context) => {
	const document = page();
	Object.defineProperty(document, "title", {
		get() {
			throw new Error("title is unavailable");
		},
	});
	const { options, files, storage, runObscura } = setup(context, document);

	const result = searchDuckDuckGo("example", options);

	await assert.rejects(result, { message: `${challengeMessage}\nDiagnostic report could not be saved.` });
	assert.equal(runObscura.mock.callCount(), 1);
	assert.equal(storage.createDirectory.mock.callCount(), 0);
	assert.equal(files.size, 0);
});

test("invalid evidence preserves the challenge error without writing a report", async (context) => {
	const { options, storage, runObscura } = setup(context);
	const output = await scan([
		Buffer.from(JSON.stringify({ pageUrl, challenge: true, results: [], evidence: { matches: "invalid" } })),
	]);
	assert.equal(output.truncated, false);
	runObscura.mock.mockImplementation(async () => ({ output }));

	const result = searchDuckDuckGo("example", options);

	await assert.rejects(result, { message: `${challengeMessage}\nDiagnostic report could not be saved.` });
	assert.equal(storage.createDirectory.mock.callCount(), 0);
});

test("cancellation during version lookup prevents report creation", async (context) => {
	const { options, exec, storage } = setup(context);
	const controller = new AbortController();
	exec.mock.mockImplementation(async () => {
		controller.abort();
		throw new Error("cancelled");
	});

	const result = searchDuckDuckGo("example", { ...options, signal: controller.signal });

	await assert.rejects(result, { message: "DuckDuckGo search was cancelled" });
	assert.equal(storage.createDirectory.mock.callCount(), 0);
});

test("retains evidence when combined and individual selector checks disagree", async (context) => {
	const document = page(new Map([[combinedSelector, element]]));
	const { options, files } = setup(context, document);

	const result = searchDuckDuckGo("example", options);

	await assert.rejects(result, { message: `${challengeMessage}\nDiagnostic report: /reports/search-1` });
	const report = JSON.parse(files.get("/reports/search-1/report.json")!);
	assert.equal(report.page.challenge, true);
	assert.deepEqual(report.page.matches, []);
	assert.equal(report.page.pageText.text, "Verify this search");
	assert.equal(files.get("/reports/search-1/stderr.txt"), "browser log");
});

test("bounds version output in the report", async (context) => {
	const { options, files, exec } = setup(context);
	exec.mock.mockImplementation(async () => ({ stdout: "v".repeat(20_000), stderr: "", code: 0, killed: false }));

	const result = searchDuckDuckGo("example", options);

	await assert.rejects(result, { message: `${challengeMessage}\nDiagnostic report: /reports/search-1` });
	const version = JSON.parse(files.get("/reports/search-1/report.json")!).obscura.version;
	assert.equal(Buffer.byteLength(version), 1024);
	assert.match(version, /\[Version output truncated\.\]$/u);
});

function registerSearch(runObscura: RunObscura): SearchTool {
	let tool: SearchTool | undefined;
	registerTool(
		{
			registerTool(definition) {
				tool = definition;
			},
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		},
		{ runObscura },
	);
	assert.ok(tool);
	return tool;
}

test("web_search enables diagnostics when the environment setting is 1", async (context) => {
	context.mock.property(process, "env", { PI_WEB_SEARCH_DIAGNOSTICS: "1" });
	const { runObscura } = setup(context, page(new Map()));
	const tool = registerSearch(runObscura);

	await tool.execute("search", { query: "enabled diagnostics" }, undefined, undefined, { cwd: "/project" });

	assert.equal(runObscura.mock.calls[0].arguments[0].verbose, true);
});

test("web_search leaves diagnostics disabled when the environment setting is absent", async (context) => {
	context.mock.property(process, "env", {});
	const { runObscura } = setup(context, page(new Map()));
	const tool = registerSearch(runObscura);

	await tool.execute("search", { query: "default diagnostics" }, undefined, undefined, { cwd: "/project" });

	assert.equal(runObscura.mock.calls[0].arguments[0].verbose, undefined);
});

test("web_search leaves diagnostics disabled for other setting values", async (context) => {
	context.mock.property(process, "env", { PI_WEB_SEARCH_DIAGNOSTICS: "true" });
	const { runObscura } = setup(context, page(new Map()));
	const tool = registerSearch(runObscura);

	await tool.execute("search", { query: "other diagnostics value" }, undefined, undefined, { cwd: "/project" });

	assert.equal(runObscura.mock.calls[0].arguments[0].verbose, undefined);
});

test("challenge evaluation stays within the output limit with JSON escapes and large page fields", async () => {
	const largeText = '\u0000\ud800🙂"\\\n'.repeat(10_000);
	const document = {
		...page(),
		title: largeText,
		readyState: largeText,
		body: { textContent: largeText },
		querySelector: () => ({ outerHTML: largeText }),
		querySelectorAll: () => Array(100).fill({ textContent: largeText }),
	};

	const value = evaluate(document);
	const output = await scan([Buffer.from(JSON.stringify(value))]);

	assert.equal(value.challenge, true);
	assert.equal(output.truncated, false);
	assert.ok(output.truncation.totalBytes < 51_200);
	assert.equal(value.evidence.resultCount, 100);
	assert.deepEqual(value.results, []);
	assert.equal(value.evidence.title.truncated, true);
	assert.equal(value.evidence.readyState.truncated, true);
	assert.equal(value.evidence.pageText.truncated, true);
	assert.deepEqual(
		value.evidence.matches.map((match: { html: { truncated: boolean } }) => match.html.truncated),
		[true, true, true, true],
	);
});

test("challenge evaluation bounds the final URL as part of the shared sample budget", async () => {
	const longUrl = `https://html.duckduckgo.com/html/?q=${"x".repeat(20_000)}`;
	const document = { ...page(), body: { textContent: "x".repeat(20_000) } };

	const value = evaluate(document, true, longUrl);
	const output = await scan([Buffer.from(JSON.stringify(value))]);

	assert.equal(value.pageUrl.length, 4096);
	assert.equal(value.evidence.pageUrlTruncated, true);
	assert.equal(value.evidence.pageText.truncated, true);
	assert.equal(output.truncated, false);
});
