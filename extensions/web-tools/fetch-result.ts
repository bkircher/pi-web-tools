import { formatSize, type AgentToolResult, type TruncationResult } from "@earendil-works/pi-coding-agent";
import type { Details } from "./fetch-types.js";
import type { Execution, Request } from "./obscura.js";
import { formatTruncationNotice, limitText, makePrefixPreview, type LimitedText } from "./output.js";

function formatOutput(execution: Execution, stderr: string | undefined): LimitedText {
	const { output } = execution;
	const { truncation } = output;
	let text = truncation.content;

	if (output.truncated) {
		const firstLinePreview = truncation.firstLineExceedsLimit
			? makePrefixPreview(output.text, truncation.maxBytes)
			: undefined;
		text = firstLinePreview?.content ?? text;

		if (firstLinePreview) {
			text += `\n\n[Output truncated: first line exceeds the ${formatSize(truncation.maxBytes)} output limit.`;
			text += ` Showing the first ${formatSize(firstLinePreview.bytes)} of ${formatSize(truncation.totalBytes)}.`;
		} else {
			text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
			text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
		}
		text += ` Full output saved to: ${output.fullOutputPath}]`;
	}

	if (!text) text = "No content returned.";
	if (stderr) text += `\n\n[Obscura stderr]\n${stderr}`;

	const retentionDetails = output.truncated ? `Full page output saved to: ${output.fullOutputPath}` : undefined;
	return limitText(text, formatTruncationNotice("Tool output", retentionDetails));
}

export function createResult(request: Request, execution: Execution, elapsedMs: number): AgentToolResult<Details> {
	const { output } = execution;
	const limitedStderr = execution.stderr
		? limitText(execution.stderr, formatTruncationNotice("Obscura stderr"))
		: undefined;
	const formattedOutput = formatOutput(execution, execution.stderr);
	let effectiveTruncation: TruncationResult | undefined;
	if (formattedOutput.truncation.truncated) {
		effectiveTruncation = formattedOutput.truncation;
	} else if (output.truncated) {
		effectiveTruncation = { ...output.truncation, truncated: true };
	}
	const outputDetails = effectiveTruncation
		? {
				truncated: true as const,
				truncation: effectiveTruncation,
				...(output.truncated ? { fullOutputPath: output.fullOutputPath } : {}),
			}
		: { truncated: false as const };
	const commonDetails = {
		url: request.url,
		waitUntil: request.waitUntil,
		wait: request.wait,
		timeout: request.timeout,
		stealth: true as const,
		proxy: Boolean(request.proxy),
		elapsedMs,
		bytes: output.truncation.totalBytes,
		...outputDetails,
		...(limitedStderr ? { stderr: limitedStderr.text } : {}),
	};
	const details: Details =
		request.mode === "eval"
			? { ...commonDetails, mode: "eval", eval: request.script }
			: {
					...commonDetails,
					mode: "dump",
					dump: request.dump,
					...(request.selector ? { selector: request.selector } : {}),
				};

	return {
		content: [{ type: "text", text: formattedOutput.text }],
		details,
	};
}
