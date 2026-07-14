import type { TruncationResult } from "@earendil-works/pi-coding-agent";

export const DUMP_MODES = ["markdown", "text", "html", "links", "assets"] as const;
export const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;

export type DumpMode = (typeof DUMP_MODES)[number];
export type WaitUntil = (typeof WAIT_UNTIL)[number];

export type Details = {
	url: string;
	waitUntil: WaitUntil;
	wait: number;
	timeout: number;
	stealth: true;
	proxy: boolean;
	elapsedMs: number;
	bytes: number;
	stderr?: string;
} & (
	| { truncated: false; truncation?: never; fullOutputPath?: never }
	| { truncated: true; truncation: TruncationResult; fullOutputPath: string }
) &
	(
		| { mode: "dump"; dump: DumpMode; eval?: never; selector?: string }
		| { mode: "eval"; eval: string; dump?: never; selector?: never }
	);
