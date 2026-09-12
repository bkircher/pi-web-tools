import { createReadStream } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type ExecResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { DumpMode, WaitUntil } from "./fetch-types.js";
import { limitText, scan, type CompleteScanResult, type ScanResult, type TruncatedScanResult } from "./output.js";

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
	| (CompleteScanResult & { fullOutputPath?: never })
	| (TruncatedScanResult & { fullOutputPath: string });

export type Execution = {
	output: PreparedOutput;
	stderr?: string;
};

export type ObscuraErrorCode = "cancelled" | "command-failed" | "timeout";

export class ObscuraError extends Error {
	constructor(
		public readonly code: ObscuraErrorCode,
		message: string,
		public readonly processTimeoutSeconds?: number,
	) {
		super(message);
		this.name = "ObscuraError";
	}
}

export type Exec = ExtensionAPI["exec"];

export type Storage = {
	createWorkingDirectory(): Promise<string>;
	readOutputFile(path: string): Promise<ScanResult>;
	retainOutput(source: OutputSource): Promise<string>;
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
	if (!source.scan.truncated) return source.scan;

	return {
		...source.scan,
		fullOutputPath: await storage.retainOutput(source),
	};
}

const DIAGNOSTIC_LIMIT = `${DEFAULT_MAX_LINES}-line or ${formatSize(DEFAULT_MAX_BYTES)}`;
const OBSCURA_TIMEOUT_EXIT_CODE = 124;
const PROCESS_TIMEOUT_GRACE_SECONDS = 10;

export function calculateProcessTimeoutSeconds(
	navigationTimeoutSeconds: number,
	postNavigationWaitSeconds: number,
): number {
	return navigationTimeoutSeconds + postNavigationWaitSeconds + PROCESS_TIMEOUT_GRACE_SECONDS;
}

function limitDiagnostic(content: string, source: string) {
	return limitText(content, `[${source} truncated: ${DIAGNOSTIC_LIMIT} limit reached.]`);
}

function createProcessTimeoutError(processTimeoutSeconds: number): ObscuraError {
	return new ObscuraError(
		"timeout",
		`obscura fetch process timed out after ${processTimeoutSeconds} seconds`,
		processTimeoutSeconds,
	);
}

function assertSucceeded(result: ExecResult, processTimeoutSeconds: number, signal?: AbortSignal): void {
	if (result.killed) {
		if (signal?.aborted) {
			throw new ObscuraError("cancelled", "obscura fetch was cancelled");
		}
		throw createProcessTimeoutError(processTimeoutSeconds);
	}
	if (result.code === OBSCURA_TIMEOUT_EXIT_CODE) {
		throw createProcessTimeoutError(processTimeoutSeconds);
	}
	if (result.code !== 0) {
		const stderr = result.stderr.trim();
		const stdout = result.stdout.trim();
		const message = `obscura fetch failed with exit code ${result.code}: ${stderr || stdout || "no error output"}`;
		const limitedMessage = limitDiagnostic(message, "Obscura failure output");
		throw new ObscuraError("command-failed", limitedMessage.text);
	}
}

export async function execute(request: Request, options: ExecuteOptions): Promise<Execution> {
	const storage = options.storage ?? nodeStorage;
	const workingDirectory = await storage.createWorkingDirectory();
	const outputPath = join(workingDirectory, "output.txt");

	try {
		const processTimeoutSeconds = calculateProcessTimeoutSeconds(request.timeout, request.wait);
		const result = await options.exec("obscura", buildArgs(request, outputPath), {
			cwd: options.cwd,
			signal: options.signal,
			timeout: processTimeoutSeconds * 1000,
		});
		assertSucceeded(result, processTimeoutSeconds, options.signal);

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
