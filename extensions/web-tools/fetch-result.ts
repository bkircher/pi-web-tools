import { formatSize, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Details } from "./fetch-types.js";
import type { Execution, Request } from "./obscura.js";

function makePrefixPreview(content: string, maxBytes: number): { content: string; bytes: number } {
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

function formatOutput(execution: Execution): string {
	const { output } = execution;
	const { truncation } = output.scan;
	let text = truncation.content;

	if (output.retention === "retain") {
		const firstLinePreview = truncation.firstLineExceedsLimit
			? makePrefixPreview(output.scan.text, truncation.maxBytes)
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

export function createResult(request: Request, execution: Execution, elapsedMs: number): AgentToolResult<Details> {
	const { output } = execution;
	const outputDetails =
		output.retention === "retain"
			? {
					truncated: true as const,
					truncation: output.scan.truncation,
					fullOutputPath: output.fullOutputPath,
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
		bytes: output.scan.bytes,
		...outputDetails,
		...(execution.stderr ? { stderr: execution.stderr } : {}),
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
		content: [{ type: "text", text: formatOutput(execution) }],
		details,
	};
}
