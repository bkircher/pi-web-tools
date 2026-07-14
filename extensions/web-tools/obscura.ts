import { createReadStream } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { WebFetchDumpMode, WebFetchWaitUntil } from "./fetch-types.js";
import { scanOutput, type ScannedOutput } from "./output.ts";

type ObscuraRequestBase = {
	url: string;
	waitUntil: WebFetchWaitUntil;
	wait: number;
	timeout: number;
	proxy?: string;
};

export type ObscuraRequest = ObscuraRequestBase &
	({ mode: "dump"; dump: WebFetchDumpMode; selector?: string } | { mode: "eval"; script: string });

export type ObscuraOutputSource =
	| { source: "file"; path: string; output: ScannedOutput }
	| { source: "stdout"; content: string; output: ScannedOutput };

export type PreparedObscuraOutput =
	| { retention: "discard"; output: ScannedOutput }
	| { retention: "retain"; output: ScannedOutput; fullOutputPath: string };

export type ObscuraExecution = {
	output: PreparedObscuraOutput;
	stderr?: string;
};

export type ObscuraExec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export type ObscuraStorage = {
	createWorkingDirectory(): Promise<string>;
	readOutputFile(path: string): Promise<ScannedOutput>;
	retainOutput(source: ObscuraOutputSource): Promise<string>;
	removeWorkingDirectory(path: string): Promise<void>;
};

export type ExecuteObscuraOptions = {
	exec: ObscuraExec;
	cwd: string;
	signal?: AbortSignal;
	storage?: ObscuraStorage;
};

function createWebFetchTempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

async function retainOutput(source: ObscuraOutputSource): Promise<string> {
	const retainedDirectory = await createWebFetchTempDir("pi-web-fetch-output-");
	const retainedPath = join(retainedDirectory, "output.txt");

	try {
		if (source.source === "file") {
			await rename(source.path, retainedPath);
		} else {
			await writeFile(retainedPath, source.content, "utf8");
		}
		return retainedPath;
	} catch (error) {
		await rm(retainedDirectory, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

const nodeObscuraStorage: ObscuraStorage = {
	createWorkingDirectory: () => createWebFetchTempDir("pi-web-fetch-"),
	readOutputFile: (path) => scanOutput(createReadStream(path)),
	retainOutput,
	removeWorkingDirectory: (path) => rm(path, { recursive: true, force: true }),
};

export function buildObscuraArgs(request: ObscuraRequest, outputPath: string): string[] {
	const args = ["fetch", "--quiet", "--stealth"];
	if (request.mode === "eval") {
		args.push("--eval", request.script);
	} else {
		args.push("--dump", request.dump);
		if (request.selector) args.push("--selector", request.selector);
	}
	args.push("--wait-until", request.waitUntil);
	args.push("--wait", String(request.wait));
	args.push("--timeout", String(request.timeout));
	if (request.proxy) args.push("--proxy", request.proxy);
	args.push("--output", outputPath, request.url);
	return args;
}

async function getObscuraOutputSource(
	storage: ObscuraStorage,
	outputPath: string,
	stdout: string,
): Promise<ObscuraOutputSource> {
	try {
		return { source: "file", path: outputPath, output: await storage.readOutputFile(outputPath) };
	} catch {
		if (!stdout) throw new Error(`obscura fetch produced no readable output at ${outputPath}`);
		return {
			source: "stdout",
			content: stdout,
			output: await scanOutput([Buffer.from(stdout)]),
		};
	}
}

export async function prepareObscuraOutput(
	source: ObscuraOutputSource,
	retain: (source: ObscuraOutputSource) => Promise<string>,
): Promise<PreparedObscuraOutput> {
	if (!source.output.truncation.truncated) {
		return { retention: "discard", output: source.output };
	}

	return {
		retention: "retain",
		output: source.output,
		fullOutputPath: await retain(source),
	};
}

function assertObscuraSucceeded(result: ExecResult): void {
	if (result.killed) {
		throw new Error("obscura fetch was cancelled or timed out");
	}
	if (result.code !== 0) {
		const stderr = result.stderr.trim();
		const stdout = result.stdout.trim();
		throw new Error(`obscura fetch failed with exit code ${result.code}: ${stderr || stdout || "no error output"}`);
	}
}

export async function executeObscuraFetch(
	request: ObscuraRequest,
	options: ExecuteObscuraOptions,
): Promise<ObscuraExecution> {
	const storage = options.storage ?? nodeObscuraStorage;
	const workingDirectory = await storage.createWorkingDirectory();
	const outputPath = join(workingDirectory, "output.txt");

	try {
		const processTimeoutMs = (request.timeout + request.wait + 10) * 1000;
		const result = await options.exec("obscura", buildObscuraArgs(request, outputPath), {
			cwd: options.cwd,
			signal: options.signal,
			timeout: processTimeoutMs,
		});
		assertObscuraSucceeded(result);

		const source = await getObscuraOutputSource(storage, outputPath, result.stdout);
		const output = await prepareObscuraOutput(source, storage.retainOutput);
		const stderr = result.stderr.trim();
		return {
			output,
			...(stderr ? { stderr } : {}),
		};
	} finally {
		await storage.removeWorkingDirectory(workingDirectory).catch(() => {});
	}
}
