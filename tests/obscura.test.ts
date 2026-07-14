import assert from "node:assert/strict";
import test from "node:test";
import {
	buildArgs as buildObscuraArgs,
	execute as executeObscuraFetch,
	type OutputSource as ObscuraOutputSource,
	type Request as ObscuraRequest,
	type Storage as ObscuraStorage,
} from "../extensions/web-tools/obscura.ts";

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

test("persists truncated stdout fallback output before deleting the working directory", async () => {
	const stdout = "a".repeat(51_201);
	let retainedSource: ObscuraOutputSource["source"] | undefined;
	let removedWorkingDirectory: string | undefined;
	const storage: ObscuraStorage & { retainedOutputPath: string } = {
		retainedOutputPath: "/retained/output.txt",
		createWorkingDirectory: async () => "/work",
		readOutputFile: async () => {
			throw new Error("missing output file");
		},
		async retainOutput(source) {
			retainedSource = source.source;
			return this.retainedOutputPath;
		},
		removeWorkingDirectory: async (path) => {
			removedWorkingDirectory = path;
		},
	};
	const exec = async () => ({ stdout, stderr: "", code: 0, killed: false });

	const result = await executeObscuraFetch(dumpRequest, { exec, cwd: "/project", storage });

	assert.ok(result.output.retention === "retain");
	assert.equal(result.output.scan.bytes, 51_201);
	assert.equal(result.output.fullOutputPath, "/retained/output.txt");
	assert.equal(retainedSource, "stdout");
	assert.equal(removedWorkingDirectory, "/work");
});

test("deletes the working directory when Obscura fails", async () => {
	let removedWorkingDirectory: string | undefined;
	const storage: ObscuraStorage = {
		createWorkingDirectory: async () => "/work",
		readOutputFile: async () => {
			throw new Error("not used");
		},
		retainOutput: async () => "/retained/output.txt",
		removeWorkingDirectory: async (path) => {
			removedWorkingDirectory = path;
		},
	};
	const exec = async () => ({ stdout: "", stderr: "navigation failed", code: 2, killed: false });

	const result = executeObscuraFetch(dumpRequest, { exec, cwd: "/project", storage });

	await assert.rejects(result, { message: "obscura fetch failed with exit code 2: navigation failed" });
	assert.equal(removedWorkingDirectory, "/work");
});
