import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type AgentToolResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { execute, type Request } from "../shared/obscura.js";
import {
	DEFAULT_DUMP_MODE,
	DEFAULT_TIMEOUT_SECONDS,
	DEFAULT_WAIT_SECONDS,
	DEFAULT_WAIT_UNTIL,
	parameters,
} from "./parameters.js";
import { renderFetchCall, renderFetchResult } from "./render.js";
import { createResult } from "./result.js";
import type { Details } from "./types.js";
import { normalizeUrl } from "./url-policy.js";

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
		description: `Fetch a specific public URL with Obscura. Obscura stealth mode is always enabled. Defaults to Markdown output and a ${DEFAULT_WAIT_SECONDS}-second post-navigation settle wait. Page content and Obscura diagnostics are limited together to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first); truncated page content is saved to a temp file. Binary/raw responses are intentionally not supported by this tool.`,
		promptSnippet:
			"Fetch a specific public URL and return Markdown, text, HTML, links, assets, or JavaScript evaluation output.",
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
