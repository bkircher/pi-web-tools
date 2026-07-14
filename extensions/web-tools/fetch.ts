import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type AgentToolResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createResult } from "./fetch-result.js";
import { DUMP_MODES, type Details, type DumpMode, WAIT_UNTIL, type WaitUntil } from "./fetch-types.js";
import { normalizeUrl } from "./fetch-url-policy.js";
import { execute, type Request } from "./obscura.js";
import { renderFetchCall, renderFetchResult } from "./render.js";

const DEFAULT_DUMP_MODE = "markdown" satisfies DumpMode;
const DEFAULT_WAIT_UNTIL = "load" satisfies WaitUntil;
const DEFAULT_WAIT_SECONDS = 5;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_WAIT_SECONDS = 60;
const MAX_URL_LENGTH = 4096;
const MAX_EVAL_LENGTH = 5000;
const MAX_SELECTOR_LENGTH = 1000;
const MAX_PROXY_LENGTH = 2048;

const parameters = Type.Object({
	url: Type.String({
		description:
			"Public HTTP(S) URL to fetch with Obscura. Local/private-network hosts, credentials, and sensitive token parameters are rejected.",
		minLength: 1,
		maxLength: MAX_URL_LENGTH,
	}),
	dump: Type.Optional(
		StringEnum(DUMP_MODES, {
			description:
				"Output format to dump when eval is not provided. markdown preserves headings and links while removing most HTML noise. assets returns NDJSON sub-resource URLs.",
			default: DEFAULT_DUMP_MODE,
		}),
	),
	eval: Type.Optional(
		Type.String({
			description:
				"JavaScript expression to evaluate in the rendered page instead of dumping page content. Use document.querySelector(...) inside the expression when you need scoped eval output.",
			minLength: 1,
			maxLength: MAX_EVAL_LENGTH,
		}),
	),
	selector: Type.Optional(
		Type.String({
			description: "Optional CSS selector to wait for before dumping output. Not valid with eval.",
			minLength: 1,
			maxLength: MAX_SELECTOR_LENGTH,
		}),
	),
	waitUntil: Type.Optional(
		StringEnum(WAIT_UNTIL, {
			description: "Navigation readiness condition before dumping or evaluating. Default: load",
			default: DEFAULT_WAIT_UNTIL,
		}),
	),
	wait: Type.Optional(
		Type.Integer({
			description: `Extra time to wait after navigation, in seconds (default ${DEFAULT_WAIT_SECONDS})`,
			minimum: 0,
			maximum: MAX_WAIT_SECONDS,
			default: DEFAULT_WAIT_SECONDS,
		}),
	),
	timeout: Type.Optional(
		Type.Integer({
			description: `Navigation timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS})`,
			minimum: 1,
			maximum: MAX_TIMEOUT_SECONDS,
			default: DEFAULT_TIMEOUT_SECONDS,
		}),
	),
	proxy: Type.Optional(
		Type.String({
			description: "Optional HTTP or SOCKS proxy URL to pass to Obscura",
			minLength: 1,
			maxLength: MAX_PROXY_LENGTH,
		}),
	),
});

function normalizeText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Register the `web_fetch` tool, which renders and dumps a URL through Obscura.
 */
export function registerTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: `Fetch a specific public HTTP(S) URL with Obscura. Obscura stealth mode is always enabled. Defaults to Markdown output and a ${DEFAULT_WAIT_SECONDS}-second post-navigation settle wait. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first); large or truncated output is saved to a temp file. Binary/raw responses are intentionally not supported by this tool.`,
		promptSnippet:
			"Fetch a specific public URL with Obscura stealth mode and return markdown, text, HTML, links, assets, or JavaScript evaluation output.",
		promptGuidelines: [
			"Use web_fetch when the user asks to read, summarize, or extract content from a specific public URL.",
			"Use web_search for discovery; use web_fetch only after you have a concrete URL.",
			"Do not use web_fetch for localhost, private-network hosts, or URLs containing credentials or tokens.",
			"Use web_fetch dump=markdown by default. Use dump=text for plain text, dump=html when markup matters, dump=links for page links, and dump=assets for rendered sub-resource URLs.",
			"web_fetch always enables Obscura stealth mode. Do not use web_fetch to bypass logins, paywalls, CAPTCHAs, rate limits, robots restrictions, or other access controls.",
			"When using web_fetch results in an answer about external web content, cite the fetched URL.",
		],
		parameters,

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<Details>> {
			const url = await normalizeUrl(params.url);
			const evalScript = normalizeText(params.eval);
			const selector = normalizeText(params.selector);
			const proxy = normalizeText(params.proxy);
			const dump = params.dump ?? DEFAULT_DUMP_MODE;
			const waitUntil = params.waitUntil ?? DEFAULT_WAIT_UNTIL;
			const wait = params.wait ?? DEFAULT_WAIT_SECONDS;
			const timeout = params.timeout ?? DEFAULT_TIMEOUT_SECONDS;

			if (evalScript && params.dump !== undefined) {
				throw new Error("Pass either eval or dump, not both");
			}
			if (evalScript && selector) {
				throw new Error("selector is only supported with dump output; use document.querySelector(...) inside eval");
			}

			const commonRequest = {
				url,
				waitUntil,
				wait,
				timeout,
				...(proxy ? { proxy } : {}),
			};
			const request: Request = evalScript
				? { ...commonRequest, mode: "eval", script: evalScript }
				: { ...commonRequest, mode: "dump", dump, ...(selector ? { selector } : {}) };
			const startedAt = Date.now();
			const execution = await execute(request, {
				exec: (command, args, options) => pi.exec(command, args, options),
				cwd: ctx.cwd,
				signal,
			});

			return createResult(request, execution, Date.now() - startedAt);
		},

		renderCall: renderFetchCall,
		renderResult: renderFetchResult,
	});
}
