import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type AgentToolResult,
	type ExtensionAPI,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const WEB_FETCH_DUMP_MODES = ["markdown", "text", "html", "links", "assets"] as const;
const WEB_FETCH_WAIT_UNTIL_VALUES = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;

export type WebFetchDumpMode = (typeof WEB_FETCH_DUMP_MODES)[number];
export type WebFetchWaitUntil = (typeof WEB_FETCH_WAIT_UNTIL_VALUES)[number];

export type WebFetchBaseDetails = {
	url: string;
	waitUntil: WebFetchWaitUntil;
	wait: number;
	timeout: number;
	stealth: true;
	proxy: boolean;
	elapsedMs: number;
	bytes: number;
	truncated: boolean;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	stderr?: string;
};

export type WebFetchDetails = WebFetchBaseDetails &
	(
		| { mode: "dump"; dump: WebFetchDumpMode; eval?: never; selector?: string }
		| { mode: "eval"; eval: string; dump?: never; selector?: never }
	);

const DEFAULT_WEB_FETCH_DUMP_MODE = "markdown" satisfies WebFetchDumpMode;
const DEFAULT_WEB_FETCH_WAIT_UNTIL = "load" satisfies WebFetchWaitUntil;
const DEFAULT_WEB_FETCH_WAIT_SECONDS = 5;
const DEFAULT_WEB_FETCH_TIMEOUT_SECONDS = 30;
const MAX_WEB_FETCH_TIMEOUT_SECONDS = 120;
const MAX_WEB_FETCH_WAIT_SECONDS = 60;
const MAX_WEB_FETCH_URL_LENGTH = 4096;
const MAX_WEB_FETCH_EVAL_LENGTH = 5000;
const MAX_WEB_FETCH_SELECTOR_LENGTH = 1000;
const MAX_WEB_FETCH_PROXY_LENGTH = 2048;
const MAX_WEB_FETCH_CAPTURE_BYTES = 10 * 1024 * 1024;

const webFetchParams = Type.Object({
	url: Type.String({
		description: "HTTP(S) URL to fetch with Obscura",
		minLength: 1,
		maxLength: MAX_WEB_FETCH_URL_LENGTH,
	}),
	dump: Type.Optional(
		StringEnum(WEB_FETCH_DUMP_MODES, {
			description:
				"Output format to dump when eval is not provided. markdown preserves headings and links while removing most HTML noise. assets returns NDJSON sub-resource URLs.",
			default: DEFAULT_WEB_FETCH_DUMP_MODE,
		}),
	),
	eval: Type.Optional(
		Type.String({
			description:
				"JavaScript expression to evaluate in the rendered page instead of dumping page content. Use document.querySelector(...) inside the expression when you need scoped eval output.",
			minLength: 1,
			maxLength: MAX_WEB_FETCH_EVAL_LENGTH,
		}),
	),
	selector: Type.Optional(
		Type.String({
			description: "Optional CSS selector to wait for before dumping output. Not valid with eval.",
			minLength: 1,
			maxLength: MAX_WEB_FETCH_SELECTOR_LENGTH,
		}),
	),
	waitUntil: Type.Optional(
		StringEnum(WEB_FETCH_WAIT_UNTIL_VALUES, {
			description: "Navigation readiness condition before dumping or evaluating. Default: load",
			default: DEFAULT_WEB_FETCH_WAIT_UNTIL,
		}),
	),
	wait: Type.Optional(
		Type.Integer({
			description: `Extra time to wait after navigation, in seconds (default ${DEFAULT_WEB_FETCH_WAIT_SECONDS})`,
			minimum: 0,
			maximum: MAX_WEB_FETCH_WAIT_SECONDS,
			default: DEFAULT_WEB_FETCH_WAIT_SECONDS,
		}),
	),
	timeout: Type.Optional(
		Type.Integer({
			description: `Navigation timeout in seconds (default ${DEFAULT_WEB_FETCH_TIMEOUT_SECONDS}, max ${MAX_WEB_FETCH_TIMEOUT_SECONDS})`,
			minimum: 1,
			maximum: MAX_WEB_FETCH_TIMEOUT_SECONDS,
			default: DEFAULT_WEB_FETCH_TIMEOUT_SECONDS,
		}),
	),
	proxy: Type.Optional(
		Type.String({
			description: "Optional HTTP or SOCKS proxy URL to pass to Obscura",
			minLength: 1,
			maxLength: MAX_WEB_FETCH_PROXY_LENGTH,
		}),
	),
});

function normalizeWebFetchUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error(`Invalid URL: ${input}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("web_fetch only supports http:// and https:// URLs");
	}

	return url.href;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function createWebFetchTempDir(): Promise<string> {
	return mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "pi-web-fetch-"));
}

async function readObscuraOutput(outputPath: string): Promise<{ text: string; bytes: number; tooLarge: boolean }> {
	const outputStats = await stat(outputPath);
	if (outputStats.size <= MAX_WEB_FETCH_CAPTURE_BYTES) {
		return {
			text: await readFile(outputPath, "utf8"),
			bytes: outputStats.size,
			tooLarge: false,
		};
	}

	const file = await open(outputPath, "r");
	try {
		const buffer = Buffer.alloc(DEFAULT_MAX_BYTES);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		return {
			text: buffer.subarray(0, bytesRead).toString("utf8"),
			bytes: outputStats.size,
			tooLarge: true,
		};
	} finally {
		await file.close();
	}
}

function makeUtf8PrefixPreview(content: string, maxBytes: number): { content: string; bytes: number } {
	let bytes = 0;
	let endIndex = 0;

	for (const char of content) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (bytes + charBytes > maxBytes) break;
		bytes += charBytes;
		endIndex += char.length;
	}

	return {
		content: content.slice(0, endIndex),
		bytes,
	};
}

/**
 * Register the `web_fetch` tool, which renders and dumps a URL through Obscura.
 */
export function registerWebFetchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch a specific HTTP(S) URL with Obscura. Obscura stealth mode is always enabled. Defaults to markdown output and a ${DEFAULT_WEB_FETCH_WAIT_SECONDS}-second post-navigation settle wait. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first); large or truncated output is saved to a temp file. Binary/raw responses are intentionally not supported by this tool.`,
		promptSnippet:
			"Fetch a specific URL with Obscura stealth mode and return markdown, text, HTML, links, assets, or JavaScript evaluation output.",
		promptGuidelines: [
			"Use web_fetch when the user asks to read, summarize, or extract content from a specific URL.",
			"Use web_search for discovery; use web_fetch only after you have a concrete URL.",
			"Use web_fetch dump=markdown by default. Use dump=text for plain text, dump=html when markup matters, dump=links for page links, and dump=assets for rendered sub-resource URLs.",
			"web_fetch always enables Obscura stealth mode. Do not use web_fetch to bypass logins, paywalls, CAPTCHAs, rate limits, robots restrictions, or other access controls.",
			"When using web_fetch results in an answer about external web content, cite the fetched URL.",
		],
		parameters: webFetchParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<WebFetchDetails>> {
			const url = normalizeWebFetchUrl(params.url);
			const evalScript = normalizeOptionalText(params.eval);
			const selector = normalizeOptionalText(params.selector);
			const proxy = normalizeOptionalText(params.proxy);
			const dump = params.dump ?? DEFAULT_WEB_FETCH_DUMP_MODE;
			const waitUntil = params.waitUntil ?? DEFAULT_WEB_FETCH_WAIT_UNTIL;
			const wait = params.wait ?? DEFAULT_WEB_FETCH_WAIT_SECONDS;
			const timeout = params.timeout ?? DEFAULT_WEB_FETCH_TIMEOUT_SECONDS;

			if (evalScript && params.dump !== undefined) {
				throw new Error("Pass either eval or dump, not both");
			}
			if (evalScript && selector) {
				throw new Error("selector is only supported with dump output; use document.querySelector(...) inside eval");
			}

			const startedAt = Date.now();
			const tempDir = await createWebFetchTempDir();
			const outputPath = join(tempDir, "output.txt");
			let keepTempDir = false;

			try {
				const args = ["fetch", "--quiet", "--stealth"];
				if (evalScript) {
					args.push("--eval", evalScript);
				} else {
					args.push("--dump", dump);
				}
				if (selector) args.push("--selector", selector);
				args.push("--wait-until", waitUntil);
				args.push("--wait", String(wait));
				args.push("--timeout", String(timeout));
				if (proxy) args.push("--proxy", proxy);
				args.push("--output", outputPath, url);

				const processTimeoutMs = (timeout + wait + 10) * 1000;
				const result = await pi.exec("obscura", args, {
					cwd: ctx.cwd,
					signal,
					timeout: processTimeoutMs,
				});

				if (result.killed) {
					throw new Error("obscura fetch was cancelled or timed out");
				}
				if (result.code !== 0) {
					const stderr = result.stderr.trim();
					const stdout = result.stdout.trim();
					throw new Error(
						`obscura fetch failed with exit code ${result.code}: ${stderr || stdout || "no error output"}`,
					);
				}

				let output: { text: string; bytes: number; tooLarge: boolean };
				try {
					output = await readObscuraOutput(outputPath);
				} catch {
					if (!result.stdout) throw new Error(`obscura fetch produced no readable output at ${outputPath}`);
					output = {
						text: result.stdout,
						bytes: Buffer.byteLength(result.stdout, "utf8"),
						tooLarge: false,
					};
				}

				const truncation = truncateHead(output.text, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				const firstLinePreview = truncation.firstLineExceedsLimit
					? makeUtf8PrefixPreview(output.text, DEFAULT_MAX_BYTES)
					: undefined;
				const stderr = result.stderr.trim();
				const truncated = output.tooLarge || truncation.truncated;
				keepTempDir = truncated;

				const commonDetails: WebFetchBaseDetails = {
					url,
					waitUntil,
					wait,
					timeout,
					stealth: true,
					proxy: Boolean(proxy),
					elapsedMs: Date.now() - startedAt,
					bytes: output.bytes,
					truncated,
					...(truncation.truncated ? { truncation } : {}),
					...(truncated ? { fullOutputPath: outputPath } : {}),
					...(stderr ? { stderr } : {}),
				};
				const details: WebFetchDetails = evalScript
					? { ...commonDetails, mode: "eval", eval: evalScript }
					: { ...commonDetails, mode: "dump", dump, ...(selector ? { selector } : {}) };

				let text = firstLinePreview?.content ?? truncation.content;
				if (!text) text = "No content returned.";
				if (output.tooLarge) {
					const shownBytes = firstLinePreview?.bytes ?? truncation.outputBytes;
					text += `\n\n[Output truncated: output is ${formatSize(output.bytes)}, which exceeds the ${formatSize(MAX_WEB_FETCH_CAPTURE_BYTES)} in-memory capture limit.`;
					text += ` Showing the first ${formatSize(shownBytes)} available to the tool.`;
					text += ` Full output saved to: ${outputPath}]`;
				} else if (firstLinePreview) {
					text += `\n\n[Output truncated: first line exceeds the ${formatSize(DEFAULT_MAX_BYTES)} output limit.`;
					text += ` Showing the first ${formatSize(firstLinePreview.bytes)} of ${formatSize(truncation.totalBytes)}.`;
					text += ` Full output saved to: ${outputPath}]`;
				} else if (truncation.truncated) {
					text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
					text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
					text += ` Full output saved to: ${outputPath}]`;
				}
				if (stderr) {
					text += `\n\n[Obscura stderr]\n${stderr}`;
				}

				return {
					content: [{ type: "text", text }],
					details,
				};
			} finally {
				if (!keepTempDir) {
					await rm(tempDir, { recursive: true, force: true }).catch(() => {});
				}
			}
		},
	});
}
