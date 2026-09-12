import { createReadStream } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

type PreparedOutput =
	| { retention: "discard"; scan: ScanResult }
	| { retention: "retain"; scan: ScanResult; fullOutputPath: string };

export type Execution = {
	output: PreparedOutput;
	stderr?: string;
};

export type ObscuraErrorCode = "cancelled" | "command-failed" | "timeout";

export class ObscuraError extends Error {
	constructor(
		public readonly code: ObscuraErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ObscuraError";
	}
}

export type Exec = ExtensionAPI["exec"];

export type Storage = {
	createWorkingDirectory(): Promise<string>;
	readOutputFile(path: string): Promise<ScanResult>;
	retainOutput(path: string): Promise<string>;
	removeWorkingDirectory(path: string): Promise<void>;
};

export type ExecuteOptions = {
	exec: Exec;
	cwd: string;
	signal?: AbortSignal;
	storage?: Storage;
};

function createTempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

async function retainOutput(path: string): Promise<string> {
	const retainedDirectory = await createTempDir("pi-web-fetch-output-");
	const retainedPath = join(retainedDirectory, "output.txt");

	try {
		await rename(path, retainedPath);
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

async function prepareOutput(scan: ScanResult, outputPath: string, storage: Storage): Promise<PreparedOutput> {
	if (!scan.truncation.truncated) return { retention: "discard", scan };

	return {
		retention: "retain",
		scan,
		fullOutputPath: await storage.retainOutput(outputPath),
	};
}

function assertSucceeded(result: ExecResult, signal?: AbortSignal): void {
	if (result.killed) {
		if (signal?.aborted) {
			throw new ObscuraError("cancelled", "obscura fetch was cancelled");
		}
		throw new ObscuraError("timeout", "obscura fetch timed out");
	}
	if (result.code !== 0) {
		const stderr = result.stderr.trim();
		const stdout = result.stdout.trim();
		throw new ObscuraError(
			"command-failed",
			`obscura fetch failed with exit code ${result.code}: ${stderr || stdout || "no error output"}`,
		);
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
		assertSucceeded(result, options.signal);

		const scan = await storage.readOutputFile(outputPath);
		const output = await prepareOutput(scan, outputPath, storage);
		const stderr = result.stderr.trim();
		return {
			output,
			...(stderr ? { stderr } : {}),
		};
	} finally {
		await storage.removeWorkingDirectory(workingDirectory).catch(() => {});
	}
}
