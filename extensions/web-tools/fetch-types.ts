import type { TruncationResult } from "@earendil-works/pi-coding-agent";

export const WEB_FETCH_DUMP_MODES = ["markdown", "text", "html", "links", "assets"] as const;
export const WEB_FETCH_WAIT_UNTIL_VALUES = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;

export type WebFetchDumpMode = (typeof WEB_FETCH_DUMP_MODES)[number];
export type WebFetchWaitUntil = (typeof WEB_FETCH_WAIT_UNTIL_VALUES)[number];

type WebFetchCommonDetails = {
	url: string;
	waitUntil: WebFetchWaitUntil;
	wait: number;
	timeout: number;
	stealth: true;
	proxy: boolean;
	elapsedMs: number;
	bytes: number;
	stderr?: string;
};

type WebFetchOutputDetails =
	| { truncated: false; truncation?: never; fullOutputPath?: never }
	| { truncated: true; truncation: TruncationResult; fullOutputPath: string };

export type WebFetchBaseDetails = WebFetchCommonDetails & WebFetchOutputDetails;

export type WebFetchDetails = WebFetchBaseDetails &
	(
		| { mode: "dump"; dump: WebFetchDumpMode; eval?: never; selector?: string }
		| { mode: "eval"; eval: string; dump?: never; selector?: never }
	);
