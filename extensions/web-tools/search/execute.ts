import {
	calculateProcessTimeoutSeconds,
	execute,
	ObscuraError,
	type ExecuteOptions,
	type Execution,
	type Request,
} from "../shared/obscura.js";
import { formatTruncationNotice, limitText } from "../shared/output.js";
import { saveChallengeReport, type DiagnosticStorage } from "./diagnostics.js";
import { buildSearchUrl, MAX_RESULTS, normalizeResults } from "./duckduckgo.js";
import { buildSearchEvaluationScript } from "./evaluation.js";
import type { ResponseData, UntrustedResult } from "./types.js";

type EvaluationData = {
	pageUrl: string;
	challenge: boolean;
	results: UntrustedResult[];
	evidence?: unknown;
};

export type RunObscura = typeof execute;

const SEARCH_HOSTNAME = buildSearchUrl("").hostname;
const SEARCH_NAVIGATION_TIMEOUT_SECONDS = 10;

const CHALLENGE_MESSAGE = "DuckDuckGo blocked the search with an anti-bot challenge";

function errorReason(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

function throwObscuraFailure(reason: string): never {
	throw new Error(`DuckDuckGo search failed through Obscura: ${reason}`);
}

function parseEvaluation(execution: Execution): EvaluationData {
	if (execution.output.truncated) {
		return throwObscuraFailure("Obscura returned truncated evaluation output");
	}

	let value: unknown;
	try {
		value = JSON.parse(execution.output.text);
	} catch {
		return throwObscuraFailure("Obscura returned invalid JSON");
	}

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return throwObscuraFailure("Obscura returned an invalid evaluation object");
	}

	const record = value as Record<string, unknown>;
	if (typeof record.pageUrl !== "string") {
		return throwObscuraFailure("Obscura returned an invalid pageUrl field");
	}
	if (typeof record.challenge !== "boolean") {
		return throwObscuraFailure("Obscura returned an invalid challenge field");
	}
	if (!Array.isArray(record.results) || record.results.length > MAX_RESULTS) {
		return throwObscuraFailure("Obscura returned an invalid results field");
	}

	const results: UntrustedResult[] = record.results.map((result) => {
		if (typeof result !== "object" || result === null || Array.isArray(result)) {
			return throwObscuraFailure("Obscura returned an invalid search result");
		}

		const rawResult = result as Record<string, unknown>;
		if (
			typeof rawResult.title !== "string" ||
			typeof rawResult.href !== "string" ||
			(rawResult.snippet !== undefined && typeof rawResult.snippet !== "string")
		) {
			return throwObscuraFailure("Obscura returned invalid search result fields");
		}

		return {
			title: rawResult.title,
			href: rawResult.href,
			...(rawResult.snippet === undefined ? {} : { snippet: rawResult.snippet }),
		};
	});

	return {
		pageUrl: record.pageUrl,
		challenge: record.challenge,
		results,
		evidence: record.evidence,
	};
}

function validateFinalHost(pageUrl: string): void {
	let url: URL;
	try {
		url = new URL(pageUrl);
	} catch {
		throwObscuraFailure("Obscura returned an invalid final page URL");
	}

	if (url.hostname !== SEARCH_HOSTNAME) {
		throwObscuraFailure(`Obscura returned an unexpected final host: ${url.hostname || "missing host"}`);
	}
}

export async function searchDuckDuckGo(
	query: string,
	options: {
		exec: ExecuteOptions["exec"];
		cwd: string;
		signal?: AbortSignal;
		runObscura?: RunObscura;
		diagnostics?: boolean;
		diagnosticStorage?: DiagnosticStorage;
	},
): Promise<ResponseData> {
	if (options.signal?.aborted) throw new Error("DuckDuckGo search was cancelled");

	const searchUrl = buildSearchUrl(query).href;
	const request: Request = {
		mode: "eval",
		script: buildSearchEvaluationScript(options.diagnostics === true),
		url: searchUrl,
		waitUntil: "domcontentloaded",
		wait: 0,
		timeout: SEARCH_NAVIGATION_TIMEOUT_SECONDS,
		...(options.diagnostics ? { verbose: true } : {}),
	};
	const processTimeoutSeconds = calculateProcessTimeoutSeconds(request.timeout, request.wait);
	let execution: Execution;

	try {
		execution = await (options.runObscura ?? execute)(request, {
			exec: options.exec,
			cwd: options.cwd,
			signal: options.signal,
		});
	} catch (error) {
		if (options.signal?.aborted || (error instanceof ObscuraError && error.code === "cancelled")) {
			throw new Error("DuckDuckGo search was cancelled", { cause: error });
		}
		if (error instanceof ObscuraError && error.code === "timeout") {
			const timeoutSeconds = error.processTimeoutSeconds ?? processTimeoutSeconds;
			throw new Error(`DuckDuckGo search timed out after ${timeoutSeconds} seconds`, { cause: error });
		}
		const failure = limitText(
			`DuckDuckGo search failed through Obscura: ${errorReason(error)}`,
			formatTruncationNotice("DuckDuckGo search failure"),
		);
		throw new Error(failure.text, { cause: error });
	}

	if (options.signal?.aborted) throw new Error("DuckDuckGo search was cancelled");

	const evaluation = parseEvaluation(execution);
	validateFinalHost(evaluation.pageUrl);
	if (evaluation.challenge) {
		if (!options.diagnostics) throw new Error(CHALLENGE_MESSAGE);

		let reportPath: string;
		try {
			reportPath = await saveChallengeReport(
				{ query, request, pageUrl: evaluation.pageUrl, evidence: evaluation.evidence, stderr: execution.stderr },
				{ exec: options.exec, cwd: options.cwd, signal: options.signal, storage: options.diagnosticStorage },
			);
		} catch (error) {
			if (options.signal?.aborted) throw new Error("DuckDuckGo search was cancelled", { cause: error });
			throw new Error(`${CHALLENGE_MESSAGE}\nDiagnostic report could not be saved.`, { cause: error });
		}
		throw new Error(`${CHALLENGE_MESSAGE}\nDiagnostic report: ${reportPath}`);
	}

	const stderr =
		!options.diagnostics && execution.stderr
			? limitText(execution.stderr, formatTruncationNotice("Obscura stderr")).text
			: undefined;
	return {
		backend: "obscura",
		searchUrl,
		bytes: execution.output.truncation.totalBytes,
		results: normalizeResults(evaluation.results, MAX_RESULTS),
		...(stderr ? { stderr } : {}),
	};
}
