import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { DUMP_MODES, type DumpMode, WAIT_UNTIL, type WaitUntil } from "../shared/obscura.js";

export const DEFAULT_DUMP_MODE = "markdown" satisfies DumpMode;
export const DEFAULT_WAIT_UNTIL = "load" satisfies WaitUntil;
export const DEFAULT_WAIT_SECONDS = 5;
export const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_WAIT_SECONDS = 60;
const MAX_URL_LENGTH = 4096;
const MAX_EVAL_LENGTH = 5000;
const MAX_SELECTOR_LENGTH = 1000;
const MAX_PROXY_LENGTH = 2048;

export const parameters = Type.Object({
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

export type FetchParameters = Static<typeof parameters>;
