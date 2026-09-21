import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import type { DumpMode, WaitUntil } from "../shared/obscura.js";

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
	| { truncated: true; truncation: TruncationResult; fullOutputPath?: string }
) &
	(
		| { mode: "dump"; dump: DumpMode; eval?: never; selector?: string }
		| { mode: "eval"; eval: string; dump?: never; selector?: never }
	);
