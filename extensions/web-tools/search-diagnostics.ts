import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecuteOptions, Request } from "./obscura.js";
import { formatTruncationNotice, limitText } from "./output.js";
import { CHALLENGE_SELECTORS, DIAGNOSTIC_CHARACTER_BUDGET } from "./search-evaluation.js";

type Sample = { text: string; truncated: boolean };

type Evidence = {
	pageUrlTruncated: boolean;
	title: Sample;
	readyState: Sample;
	resultCount: number;
	matches: { selector: string; html: Sample }[];
	pageText: Sample;
};

export type DiagnosticStorage = {
	createDirectory(): Promise<string>;
	writeFile(path: string, content: string, options: { mode: number; flag: "wx" }): Promise<void>;
	removeDirectory(path: string): Promise<void>;
};

const nodeStorage: DiagnosticStorage = {
	// mkdtemp creates the directory with mode 0700, subject to the process umask.
	createDirectory: () => mkdtemp(join(tmpdir(), "pi-web-search-failure-")),
	writeFile,
	removeDirectory: (path) => rm(path, { recursive: true, force: true }),
};

function invalidEvidence(): never {
	throw new Error("Obscura returned invalid or missing challenge evidence");
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidEvidence();
	return value as Record<string, unknown>;
}

function sample(value: unknown): Sample {
	const fields = record(value);
	if (
		typeof fields.text !== "string" ||
		fields.text.length > DIAGNOSTIC_CHARACTER_BUDGET ||
		typeof fields.truncated !== "boolean"
	) {
		return invalidEvidence();
	}
	return { text: fields.text, truncated: fields.truncated };
}

function parseEvidence(value: unknown): Evidence {
	const fields = record(value);
	if (
		typeof fields.pageUrlTruncated !== "boolean" ||
		typeof fields.resultCount !== "number" ||
		!Number.isSafeInteger(fields.resultCount) ||
		fields.resultCount < 0 ||
		!Array.isArray(fields.matches) ||
		fields.matches.length > CHALLENGE_SELECTORS.length
	) {
		return invalidEvidence();
	}
	const matches = fields.matches.map((value) => {
		const match = record(value);
		if (!CHALLENGE_SELECTORS.some((selector) => selector === match.selector)) return invalidEvidence();
		return { selector: match.selector as string, html: sample(match.html) };
	});
	return {
		pageUrlTruncated: fields.pageUrlTruncated,
		title: sample(fields.title),
		readyState: sample(fields.readyState),
		resultCount: fields.resultCount,
		matches,
		pageText: sample(fields.pageText),
	};
}

async function readVersion(options: Pick<ExecuteOptions, "exec" | "cwd" | "signal">): Promise<string | null> {
	try {
		const result = await options.exec("obscura", ["--version"], {
			cwd: options.cwd,
			signal: options.signal,
			timeout: 2000,
		});
		if (result.killed || result.code !== 0 || !result.stdout.trim()) return null;
		return limitText(result.stdout.trim(), "[Version output truncated.]", { maxBytes: 1024, maxLines: 10 }).text;
	} catch {
		return null;
	}
}

/** Save evidence from an existing navigation. This function does not fetch a page. */
export async function saveChallengeReport(
	input: {
		query: string;
		request: Request;
		pageUrl: string;
		evidence: unknown;
		stderr?: string;
	},
	options: Pick<ExecuteOptions, "exec" | "cwd" | "signal"> & { storage?: DiagnosticStorage },
): Promise<string> {
	const evidence = parseEvidence(input.evidence);
	const capturedAt = new Date().toISOString();
	const version = await readVersion(options);
	options.signal?.throwIfAborted();
	const stderr = limitText(input.stderr ?? "", formatTruncationNotice("Obscura stderr"));
	const report = {
		schemaVersion: 1,
		capturedAt,
		query: input.query,
		searchUrl: input.request.url,
		navigation: {
			waitUntil: input.request.waitUntil,
			wait: input.request.wait,
			timeout: input.request.timeout,
			stealth: true,
			verbose: input.request.verbose === true,
		},
		obscura: { command: "obscura", version },
		page: {
			challenge: true,
			url: input.pageUrl,
			...evidence,
			matches: evidence.matches.map(({ selector, html }) => ({ selector, htmlTruncated: html.truncated })),
		},
		stderrTruncated: stderr.truncation.truncated,
	};
	const html = evidence.matches
		.map(({ selector, html }) => `<!-- Selector: ${selector}; truncated: ${html.truncated} -->\n${html.text}`)
		.join("\n\n");
	const storage = options.storage ?? nodeStorage;
	const directory = await storage.createDirectory();
	const fileOptions = { mode: 0o600, flag: "wx" } as const;

	try {
		await storage.writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, fileOptions);
		await storage.writeFile(join(directory, "challenge.html"), `${html}\n`, fileOptions);
		await storage.writeFile(join(directory, "stderr.txt"), stderr.text, fileOptions);
		return directory;
	} catch (error) {
		await storage.removeDirectory(directory).catch(() => {});
		throw error;
	}
}
