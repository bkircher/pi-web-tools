import assert from "node:assert/strict";
import test from "node:test";
import {
	buildArgs as buildObscuraArgs,
	execute as executeObscuraFetch,
	type Exec as ObscuraExec,
	type Request as ObscuraRequest,
	type Storage as ObscuraStorage,
} from "../extensions/web-tools/shared/obscura.ts";
import { scan as scanOutput } from "../extensions/web-tools/shared/output.ts";

const dumpRequest: ObscuraRequest = {
	mode: "dump",
	dump: "markdown",
	selector: "main",
	url: "https://example.com/docs",
	waitUntil: "networkidle2",
	wait: 5,
	timeout: 30,
	proxy: "socks5://proxy.example:1080",
};

function createStorage(overrides: Partial<ObscuraStorage> = {}): ObscuraStorage {
	return {
		createWorkingDirectory: async () => "/work",
		readOutputFile: async () => {
			throw new Error("not used");
		},
		retainOutput: async () => "/retained/output.txt",
		removeWorkingDirectory: async () => undefined,
		...overrides,
	};
}

test("builds Obscura dump arguments", () => {
	const outputPath = "/work/output.txt";

	const result = buildObscuraArgs(dumpRequest, outputPath);

	assert.deepEqual(result, [
		"fetch",
		"--quiet",
		"--stealth",
		"--dump",
		"markdown",
		"--selector",
		"main",
		"--wait-until",
		"networkidle2",
		"--wait",
		"5",
		"--timeout",
		"30",
		"--proxy",
		"socks5://proxy.example:1080",
		"--output",
		"/work/output.txt",
		"https://example.com/docs",
	]);
});

test("builds Obscura eval arguments without dump-only options", () => {
	const request: ObscuraRequest = {
		mode: "eval",
		script: "document.title",
		url: "https://example.com/",
		waitUntil: "load",
		wait: 0,
		timeout: 10,
	};

	const result = buildObscuraArgs(request, "/work/output.txt");

	assert.deepEqual(result, [
		"fetch",
		"--quiet",
		"--stealth",
		"--eval",
		"document.title",
		"--wait-until",
		"load",
		"--wait",
		"0",
		"--timeout",
		"10",
		"--output",
		"/work/output.txt",
		"https://example.com/",
	]);
});

test("enables verbose logging only when requested", () => {
	const request: ObscuraRequest = {
		mode: "eval",
		script: "document.title",
		url: "https://example.com/",
		waitUntil: "domcontentloaded",
		wait: 0,
		timeout: 10,
		verbose: true,
	};

	const result = buildObscuraArgs(request, "/work/output.txt");

	assert.deepEqual(result, [
		"fetch",
		"--verbose",
		"--stealth",
		"--eval",
		"document.title",
		"--wait-until",
		"domcontentloaded",
		"--wait",
		"0",
		"--timeout",
		"10",
		"--output",
		"/work/output.txt",
		"https://example.com/",
	]);
});

test("retains a truncated output file before deleting the working directory", async () => {
	const scan = await scanOutput([Buffer.from("a".repeat(51_201))]);
	let retainedOutputPath: string | undefined;
	let removedWorkingDirectory: string | undefined;
	const storage = createStorage({
		readOutputFile: async () => scan,
		retainOutput: async (path) => {
			retainedOutputPath = path;
			return "/retained/output.txt";
		},
		removeWorkingDirectory: async (path) => {
			removedWorkingDirectory = path;
		},
	});
	const exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });

	const result = await executeObscuraFetch(dumpRequest, { exec, cwd: "/project", storage });

	assert.equal(result.output.truncated, true);
	assert.equal(result.output.truncation.totalBytes, 51_201);
	assert.equal(result.output.fullOutputPath, "/retained/output.txt");
	assert.equal(retainedOutputPath, "/work/output.txt");
	assert.equal(removedWorkingDirectory, "/work");
});

test("propagates output file read errors", async () => {
	const readError = Object.assign(new Error("permission denied"), { code: "EACCES" });
	const storage = createStorage({
		readOutputFile: async () => {
			throw readError;
		},
	});
	const exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });

	const result = executeObscuraFetch(dumpRequest, { exec, cwd: "/project", storage });

	await assert.rejects(result, (error) => error === readError);
});

test("deletes the working directory when Obscura fails", async () => {
	let removedWorkingDirectory: string | undefined;
	const storage = createStorage({
		removeWorkingDirectory: async (path) => {
			removedWorkingDirectory = path;
		},
	});
	const exec = async () => ({ stdout: "", stderr: "navigation failed", code: 2, killed: false });

	const result = executeObscuraFetch(dumpRequest, { exec, cwd: "/project", storage });

	await assert.rejects(result, {
		name: "ObscuraError",
		code: "command-failed",
		message: "obscura fetch failed with exit code 2: navigation failed",
	});
	assert.equal(removedWorkingDirectory, "/work");
});

test("limits diagnostic output from a failed Obscura command", async () => {
	const storage = createStorage();
	const exec = async () => ({ stdout: "", stderr: "a".repeat(100_000), code: 2, killed: false });

	const result = executeObscuraFetch(dumpRequest, { exec, cwd: "/project", storage });

	await assert.rejects(result, (error) => {
		assert.ok(error instanceof Error);
		assert.equal(error.name, "ObscuraError");
		assert.equal(Buffer.byteLength(error.message, "utf8"), 51_200);
		assert.match(error.message, /\[Obscura failure output truncated: 2000-line or 50\.0KB limit reached\.\]$/u);
		return true;
	});
});

test("reports the process deadline when Pi kills Obscura", async () => {
	let processTimeoutMs: number | undefined;
	const storage = createStorage();
	const exec: ObscuraExec = async (_command, _args, options) => {
		processTimeoutMs = options?.timeout;
		return { stdout: "", stderr: "", code: 1, killed: true };
	};

	const result = executeObscuraFetch(dumpRequest, { exec, cwd: "/project", storage });

	await assert.rejects(result, {
		name: "ObscuraError",
		code: "timeout",
		message: "obscura fetch process timed out after 45 seconds",
		processTimeoutSeconds: 45,
	});
	assert.equal(processTimeoutMs, 45_000);
});

test("reports Obscura exit code 124 as a process timeout", async () => {
	const storage = createStorage();
	const exec = async () => ({ stdout: "", stderr: "hard timeout", code: 124, killed: false });

	const result = executeObscuraFetch(dumpRequest, { exec, cwd: "/project", storage });

	await assert.rejects(result, {
		name: "ObscuraError",
		code: "timeout",
		message: "obscura fetch process timed out after 45 seconds",
		processTimeoutSeconds: 45,
	});
});

test("reports a killed Obscura process with an aborted signal as cancellation", async () => {
	const controller = new AbortController();
	controller.abort();
	const storage = createStorage();
	const exec = async () => ({ stdout: "", stderr: "", code: 1, killed: true });

	const result = executeObscuraFetch(dumpRequest, {
		exec,
		cwd: "/project",
		signal: controller.signal,
		storage,
	});

	await assert.rejects(result, {
		name: "ObscuraError",
		code: "cancelled",
		message: "obscura fetch was cancelled",
	});
});
