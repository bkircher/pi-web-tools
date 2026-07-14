import { lookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
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
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { scanOutput, type ScannedOutput } from "./output.js";
import { renderWebFetchCall, renderWebFetchResult } from "./render.js";

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

type IpVersion = "ipv4" | "ipv6";

const BLOCKED_WEB_FETCH_IP_RANGES: Array<{ address: string; prefix: number; version: IpVersion }> = [
	{ address: "0.0.0.0", prefix: 8, version: "ipv4" },
	{ address: "10.0.0.0", prefix: 8, version: "ipv4" },
	{ address: "100.64.0.0", prefix: 10, version: "ipv4" },
	{ address: "127.0.0.0", prefix: 8, version: "ipv4" },
	{ address: "169.254.0.0", prefix: 16, version: "ipv4" },
	{ address: "172.16.0.0", prefix: 12, version: "ipv4" },
	{ address: "192.0.0.0", prefix: 24, version: "ipv4" },
	{ address: "192.0.2.0", prefix: 24, version: "ipv4" },
	{ address: "192.88.99.0", prefix: 24, version: "ipv4" },
	{ address: "192.168.0.0", prefix: 16, version: "ipv4" },
	{ address: "198.18.0.0", prefix: 15, version: "ipv4" },
	{ address: "198.51.100.0", prefix: 24, version: "ipv4" },
	{ address: "203.0.113.0", prefix: 24, version: "ipv4" },
	{ address: "224.0.0.0", prefix: 4, version: "ipv4" },
	{ address: "240.0.0.0", prefix: 4, version: "ipv4" },
	{ address: "::", prefix: 96, version: "ipv6" },
	{ address: "64:ff9b::", prefix: 96, version: "ipv6" },
	{ address: "64:ff9b:1::", prefix: 48, version: "ipv6" },
	{ address: "100::", prefix: 64, version: "ipv6" },
	{ address: "2001::", prefix: 32, version: "ipv6" },
	{ address: "2001:2::", prefix: 48, version: "ipv6" },
	{ address: "2001:10::", prefix: 28, version: "ipv6" },
	{ address: "2001:db8::", prefix: 32, version: "ipv6" },
	{ address: "2002::", prefix: 16, version: "ipv6" },
	{ address: "fc00::", prefix: 7, version: "ipv6" },
	{ address: "fe80::", prefix: 10, version: "ipv6" },
	{ address: "fec0::", prefix: 10, version: "ipv6" },
	{ address: "ff00::", prefix: 8, version: "ipv6" },
];

const BLOCKED_WEB_FETCH_IPS = new BlockList();
for (const { address, prefix, version } of BLOCKED_WEB_FETCH_IP_RANGES) {
	BLOCKED_WEB_FETCH_IPS.addSubnet(address, prefix, version);
}

const SPECIAL_USE_WEB_FETCH_HOSTNAMES = ["localhost", "local", "home.arpa", "internal"] as const;

const SENSITIVE_URL_FIELD_NAME_PATTERN =
	/(?:^|[^a-z0-9])(?:access[-_]?key|access[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|credential|id[-_]?token|jwt|key|pass(?:word|wd)?|pwd|refresh[-_]?token|saml(?:response)?|secret|session(?:id)?|sid|sig(?:nature)?|token)(?:$|[^a-z0-9])/iu;
const SENSITIVE_URL_VALUE_PATTERN =
	/^(?:bearer\s+|(?:[a-z0-9_-]{10,}\.){2}[a-z0-9_-]{10,}|(?:gh[pousr]_|github_pat_|glpat-|sk-[a-z0-9]|xox[baprs]-|AKIA|ASIA|AIza)[a-z0-9_-]{8,})/iu;

const webFetchParams = Type.Object({
	url: Type.String({
		description:
			"Public HTTP(S) URL to fetch with Obscura. Local/private-network hosts, credentials, and sensitive token parameters are rejected.",
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

function unbracketHostname(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function stripTrailingDots(hostname: string): string {
	return hostname.replace(/\.+$/u, "");
}

function getIpVersion(address: string): IpVersion | undefined {
	const version = isIP(unbracketHostname(address));
	if (version === 4) return "ipv4";
	if (version === 6) return "ipv6";
	return undefined;
}

function getEmbeddedIpv4FromMappedIpv6(address: string): string | undefined {
	const normalizedAddress = unbracketHostname(address);
	if (isIP(normalizedAddress) !== 6) return undefined;

	let canonicalAddress: string;
	try {
		canonicalAddress = unbracketHostname(new URL(`http://[${normalizedAddress}]/`).hostname).toLowerCase();
	} catch {
		canonicalAddress = normalizedAddress.toLowerCase();
	}

	const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonicalAddress);
	if (!match) return undefined;

	const high = Number.parseInt(match[1], 16);
	const low = Number.parseInt(match[2], 16);
	return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function isBlockedWebFetchIp(address: string): boolean {
	const normalizedAddress = unbracketHostname(address);
	const version = getIpVersion(normalizedAddress);
	if (version === undefined) return false;

	if (version === "ipv6") {
		const embeddedIpv4Address = getEmbeddedIpv4FromMappedIpv6(normalizedAddress);
		if (embeddedIpv4Address && BLOCKED_WEB_FETCH_IPS.check(embeddedIpv4Address, "ipv4")) {
			return true;
		}
	}

	return BLOCKED_WEB_FETCH_IPS.check(normalizedAddress, version);
}

function isSpecialUseWebFetchHostname(hostname: string): boolean {
	const normalizedHostname = stripTrailingDots(unbracketHostname(hostname)).toLowerCase();
	return SPECIAL_USE_WEB_FETCH_HOSTNAMES.some(
		(suffix) => normalizedHostname === suffix || normalizedHostname.endsWith(`.${suffix}`),
	);
}

function containsSensitiveUrlFieldName(value: string): boolean {
	const decodedValue = safelyDecodeUrlComponent(value);
	const normalizedValue = decodedValue.replace(/([a-z])([A-Z])/g, "$1-$2");
	return SENSITIVE_URL_FIELD_NAME_PATTERN.test(normalizedValue);
}

function containsSensitiveUrlValue(value: string): boolean {
	return SENSITIVE_URL_VALUE_PATTERN.test(value.trim());
}

function containsNestedSensitiveUrlData(value: string): boolean {
	const decodedValue = safelyDecodeUrlComponent(value);
	return /[?&#=]/u.test(decodedValue) && containsSensitiveUrlFieldName(decodedValue);
}

function containsSensitiveUrlParam(name: string, value: string): boolean {
	return (
		containsSensitiveUrlFieldName(name) || containsSensitiveUrlValue(value) || containsNestedSensitiveUrlData(value)
	);
}

function containsSensitiveUrlParams(params: Iterable<[string, string]>): boolean {
	for (const [name, value] of params) {
		if (containsSensitiveUrlParam(name, value)) return true;
	}

	return false;
}

function getFragmentUrlParams(fragment: string): URLSearchParams {
	const queryStart = fragment.indexOf("?");
	return new URLSearchParams(queryStart === -1 ? fragment : fragment.slice(queryStart + 1));
}

function safelyDecodeUrlComponent(value: string): string {
	try {
		return decodeURIComponent(value.replace(/\+/gu, " "));
	} catch {
		return value;
	}
}

function assertNoSensitiveUrlData(url: URL): void {
	if (url.username || url.password) {
		throw new Error("web_fetch URL must not include username or password credentials");
	}

	if (containsSensitiveUrlParams(url.searchParams)) {
		throw new Error("web_fetch URL query must not include credentials or tokens");
	}

	if (!url.hash) return;

	const fragment = safelyDecodeUrlComponent(url.hash.slice(1));
	if (
		containsSensitiveUrlFieldName(fragment) ||
		containsSensitiveUrlValue(fragment) ||
		(/[=&?]/u.test(fragment) && containsSensitiveUrlParams(getFragmentUrlParams(fragment)))
	) {
		throw new Error("web_fetch URL fragment must not include credentials or tokens");
	}
}

async function assertPublicWebFetchHost(url: URL): Promise<void> {
	const hostname = stripTrailingDots(unbracketHostname(url.hostname)).toLowerCase();
	if (!hostname) {
		throw new Error("web_fetch URL must include a hostname");
	}

	if (isSpecialUseWebFetchHostname(hostname)) {
		throw new Error("web_fetch URL must not target localhost or other special-use hostnames");
	}

	if (isBlockedWebFetchIp(hostname)) {
		throw new Error("web_fetch URL must not target private, local, or reserved IP addresses");
	}

	if (getIpVersion(hostname)) return;

	let addresses: Array<{ address: string }>;
	try {
		addresses = await lookup(hostname, { all: true, verbatim: true });
	} catch {
		throw new Error("web_fetch URL hostname could not be resolved");
	}

	if (addresses.length === 0) {
		throw new Error("web_fetch URL hostname did not resolve to any addresses");
	}

	if (addresses.some(({ address }) => isBlockedWebFetchIp(address))) {
		throw new Error("web_fetch URL hostname resolves to a private, local, or reserved IP address");
	}
}

async function normalizeWebFetchUrl(input: string): Promise<string> {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error("Invalid URL");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("web_fetch only supports http:// and https:// URLs");
	}

	assertNoSensitiveUrlData(url);
	await assertPublicWebFetchHost(url);

	return url.href;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function createWebFetchTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-web-fetch-"));
}

function readObscuraOutput(outputPath: string): Promise<ScannedOutput> {
	return scanOutput(createReadStream(outputPath));
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
		description: `Fetch a specific public HTTP(S) URL with Obscura. Obscura stealth mode is always enabled. Defaults to markdown output and a ${DEFAULT_WEB_FETCH_WAIT_SECONDS}-second post-navigation settle wait. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first); large or truncated output is saved to a temp file. Binary/raw responses are intentionally not supported by this tool.`,
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
		parameters: webFetchParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<WebFetchDetails>> {
			const url = await normalizeWebFetchUrl(params.url);
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

				let output: ScannedOutput;
				try {
					output = await readObscuraOutput(outputPath);
				} catch {
					if (!result.stdout) throw new Error(`obscura fetch produced no readable output at ${outputPath}`);
					output = await scanOutput([Buffer.from(result.stdout)]);
				}

				const { truncation } = output;
				const firstLinePreview = truncation.firstLineExceedsLimit
					? makeUtf8PrefixPreview(output.text, DEFAULT_MAX_BYTES)
					: undefined;
				const stderr = result.stderr.trim();
				const truncated = truncation.truncated;
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
				if (firstLinePreview) {
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

		renderCall: renderWebFetchCall,
		renderResult: renderWebFetchResult,
	});
}
