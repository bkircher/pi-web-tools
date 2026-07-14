import { formatSize, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { WebFetchBaseDetails, WebFetchDetails } from "./fetch-types.js";
import type { ObscuraExecution, ObscuraRequest } from "./obscura.js";

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

function formatOutput(execution: ObscuraExecution): string {
	const { output } = execution;
	const { truncation } = output.output;
	let text = truncation.content;

	if (output.retention === "retain") {
		const firstLinePreview = truncation.firstLineExceedsLimit
			? makeUtf8PrefixPreview(output.output.text, truncation.maxBytes)
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
	if (execution.stderr) text += `\n\n[Obscura stderr]\n${execution.stderr}`;
	return text;
}

export function createWebFetchResult(
	request: ObscuraRequest,
	execution: ObscuraExecution,
	elapsedMs: number,
): AgentToolResult<WebFetchDetails> {
	const { output } = execution;
	const outputDetails =
		output.retention === "retain"
			? {
					truncated: true as const,
					truncation: output.output.truncation,
					fullOutputPath: output.fullOutputPath,
				}
			: { truncated: false as const };
	const commonDetails: WebFetchBaseDetails = {
		url: request.url,
		waitUntil: request.waitUntil,
		wait: request.wait,
		timeout: request.timeout,
		stealth: true,
		proxy: Boolean(request.proxy),
		elapsedMs,
		bytes: output.output.bytes,
		...outputDetails,
		...(execution.stderr ? { stderr: execution.stderr } : {}),
	};
	const details: WebFetchDetails =
		request.mode === "eval"
			? { ...commonDetails, mode: "eval", eval: request.script }
			: {
					...commonDetails,
					mode: "dump",
					dump: request.dump,
					...(request.selector ? { selector: request.selector } : {}),
				};

	return {
		content: [{ type: "text", text: formatOutput(execution) }],
		details,
	};
}
