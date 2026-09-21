import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

const MAX_UTF8_CODE_POINT_BYTES = 4;

type ScanResultBase = {
	text: string;
	truncation: Omit<TruncationResult, "truncated">;
};

export type CompleteScanResult = ScanResultBase & { truncated: false };
export type TruncatedScanResult = ScanResultBase & { truncated: true };
export type ScanResult = CompleteScanResult | TruncatedScanResult;

export type LimitedText = {
	text: string;
	truncation: TruncationResult;
};

type Limits = {
	maxBytes?: number;
	maxLines?: number;
};

const OUTPUT_LIMIT_DESCRIPTION = `${DEFAULT_MAX_LINES}-line or ${formatSize(DEFAULT_MAX_BYTES)}`;

export function makePrefixPreview(content: string, maxBytes: number): { content: string; bytes: number } {
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

function countLines(content: string): number {
	if (!content) return 0;
	let lines = content.endsWith("\n") ? 0 : 1;
	for (const char of content) {
		if (char === "\n") lines += 1;
	}
	return lines;
}

export function formatTruncationNotice(source: string, details?: string): string {
	const additionalDetails = details ? ` ${details}` : "";
	return `[${source} truncated: ${OUTPUT_LIMIT_DESCRIPTION} limit reached.${additionalDetails}]`;
}

/**
 * Limits a complete text result, including its truncation notice.
 */
export function limitText(content: string, notice: string, limits: Limits = {}): LimitedText {
	const truncation = truncateHead(content, limits);
	if (!truncation.truncated) return { text: content, truncation };

	const noticeBytes = Buffer.byteLength(notice, "utf8");
	const noticeLines = countLines(notice);
	const maxPreviewBytes = Math.max(0, truncation.maxBytes - noticeBytes - 2);
	const maxPreviewLines = Math.max(0, truncation.maxLines - noticeLines - 1);
	const previewTruncation = truncateHead(content, {
		maxBytes: maxPreviewBytes,
		maxLines: maxPreviewLines,
	});
	let preview = previewTruncation.content;

	if (maxPreviewLines > 0 && previewTruncation.truncatedBy === "bytes") {
		preview = makePrefixPreview(content, maxPreviewBytes).content.replace(/\n+$/u, "");
	}

	return {
		text: preview ? `${preview}\n\n${notice}` : notice,
		truncation: {
			...truncation,
			content: preview,
			outputLines: countLines(preview),
			outputBytes: Buffer.byteLength(preview, "utf8"),
			lastLinePartial: preview.length > 0 && preview.length < content.length && content[preview.length] !== "\n",
		},
	};
}

/**
 * Scans output using constant memory while retaining only enough data to produce a bounded preview.
 */
export async function scan(
	chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
	limits: Limits = {},
): Promise<ScanResult> {
	const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
	const retainedByteLimit = maxBytes + MAX_UTF8_CODE_POINT_BYTES;
	const retainedChunks: Buffer[] = [];
	let retainedBytes = 0;
	let totalBytes = 0;
	let newlineCount = 0;
	let endsWithNewline = false;

	for await (const chunk of chunks) {
		if (chunk.byteLength === 0) continue;

		totalBytes += chunk.byteLength;
		endsWithNewline = chunk[chunk.byteLength - 1] === 0x0a;
		for (const byte of chunk) {
			if (byte === 0x0a) newlineCount += 1;
		}

		const bytesToRetain = Math.min(chunk.byteLength, retainedByteLimit - retainedBytes);
		if (bytesToRetain > 0) {
			retainedChunks.push(Buffer.from(chunk.subarray(0, bytesToRetain)));
			retainedBytes += bytesToRetain;
		}
	}

	const retainedBuffer = Buffer.concat(retainedChunks, retainedBytes);
	const text = new TextDecoder().decode(retainedBuffer, { stream: retainedBytes < totalBytes });
	const totalLines = totalBytes === 0 ? 0 : newlineCount + (endsWithNewline ? 0 : 1);
	const prefixTruncation = truncateHead(text, { maxBytes, maxLines });
	const truncated = prefixTruncation.truncated || retainedBytes < totalBytes;
	const truncatedBy = prefixTruncation.truncatedBy ?? (truncated ? "bytes" : null);

	const truncation = {
		content: prefixTruncation.content,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: prefixTruncation.outputLines,
		outputBytes: prefixTruncation.outputBytes,
		lastLinePartial: prefixTruncation.lastLinePartial,
		firstLineExceedsLimit: prefixTruncation.firstLineExceedsLimit,
		maxLines: prefixTruncation.maxLines,
		maxBytes: prefixTruncation.maxBytes,
	};

	return truncated ? { text, truncated: true, truncation } : { text, truncated: false, truncation };
}
