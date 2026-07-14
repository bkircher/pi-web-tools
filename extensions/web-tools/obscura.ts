import { createReadStream } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { DumpMode, WaitUntil } from "./fetch-types.js";
import { scan, type ScanResult } from "./output.js";

type RequestBase = {
	url: string;
	waitUntil: WaitUntil;
	wait: number;
	timeout: number;
	proxy?: string;
};

export type Request = RequestBase &
	({ mode: "dump"; dump: DumpMode; selector?: string } | { mode: "eval"; script: string });

export type OutputSource =
	| { source: "file"; path: string; scan: ScanResult }
	| { source: "stdout"; content: string; scan: ScanResult };

type PreparedOutput =
	| { retention: "discard"; scan: ScanResult }
	| { retention: "retain"; scan: ScanResult; fullOutputPath: string };

export type Execution = {
	output: PreparedOutput;
	stderr?: string;
};

type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export type Storage = {
	createWorkingDirectory(): Promise<string>;
	readOutputFile(path: string): Promise<ScanResult>;
	retainOutput(source: OutputSource): Promise<string>;
	removeWorkingDirectory(path: string): Promise<void>;
};

type ExecuteOptions = {
	exec: Exec;
	cwd: string;
	signal?: AbortSignal;
	storage?: Storage;
};

function createTempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

async function retainOutput(source: OutputSource): Promise<string> {
	const retainedDirectory = await createTempDir("pi-web-fetch-output-");
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

const nodeStorage: Storage = {
	createWorkingDirectory: () => createTempDir("pi-web-fetch-"),
	readOutputFile: (path) => scan(createReadStream(path)),
	retainOutput,
	removeWorkingDirectory: (path) => rm(path, { recursive: true, force: true }),
};

export function buildArgs(request: Request, outputPath: string): string[] {
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

function isFileNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function getOutputSource(storage: Storage, outputPath: string, stdout: string): Promise<OutputSource> {
	try {
		return { source: "file", path: outputPath, scan: await storage.readOutputFile(outputPath) };
	} catch (error) {
		if (!isFileNotFoundError(error)) throw error;
		if (!stdout) throw new Error(`obscura fetch produced no readable output at ${outputPath}`);
		return {
			source: "stdout",
			content: stdout,
			scan: await scan([Buffer.from(stdout)]),
		};
	}
}

async function prepareOutput(source: OutputSource, storage: Storage): Promise<PreparedOutput> {
	if (!source.scan.truncation.truncated) return { retention: "discard", scan: source.scan };

	return {
		retention: "retain",
		scan: source.scan,
		fullOutputPath: await storage.retainOutput(source),
	};
}

function assertSucceeded(result: ExecResult): void {
	if (result.killed) {
		throw new Error("obscura fetch was cancelled or timed out");
	}
	if (result.code !== 0) {
		const stderr = result.stderr.trim();
		const stdout = result.stdout.trim();
		throw new Error(`obscura fetch failed with exit code ${result.code}: ${stderr || stdout || "no error output"}`);
	}
}

export async function execute(request: Request, options: ExecuteOptions): Promise<Execution> {
	const storage = options.storage ?? nodeStorage;
	const workingDirectory = await storage.createWorkingDirectory();
	const outputPath = join(workingDirectory, "output.txt");

	try {
		const processTimeoutMs = (request.timeout + request.wait + 10) * 1000;
		const result = await options.exec("obscura", buildArgs(request, outputPath), {
			cwd: options.cwd,
			signal: options.signal,
			timeout: processTimeoutMs,
		});
		assertSucceeded(result);

		const source = await getOutputSource(storage, outputPath, result.stdout);
		const output = await prepareOutput(source, storage);
		const stderr = result.stderr.trim();
		return {
			output,
			...(stderr ? { stderr } : {}),
		};
	} finally {
		await storage.removeWorkingDirectory(workingDirectory).catch(() => {});
	}
}
