import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

const MAX_UTF8_CODE_POINT_BYTES = 4;

export type ScannedOutput = {
	text: string;
	bytes: number;
	truncation: TruncationResult;
};

export type OutputLimits = {
	maxBytes?: number;
	maxLines?: number;
};

/**
 * Scans output using constant memory while retaining only enough data to produce a bounded preview.
 */
export async function scanOutput(
	chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
	limits: OutputLimits = {},
): Promise<ScannedOutput> {
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
	const truncatedBy = prefixTruncation.truncatedBy ?? (truncated ? (totalBytes > maxBytes ? "bytes" : "lines") : null);

	return {
		text,
		bytes: totalBytes,
		truncation: {
			...prefixTruncation,
			truncated,
			truncatedBy,
			totalBytes,
			totalLines,
		},
	};
}
