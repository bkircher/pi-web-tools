import assert from "node:assert/strict";
import test from "node:test";
import { scanOutput } from "../extensions/web-tools/output.ts";

test("returns empty output metadata", async () => {
	const chunks: Uint8Array[] = [];

	const result = await scanOutput(chunks);

	assert.equal(result.text, "");
	assert.equal(result.bytes, 0);
	assert.equal(result.truncation.totalLines, 0);
	assert.equal(result.truncation.truncated, false);
});

test("returns output below both limits unchanged", async () => {
	const chunks = [Buffer.from("alpha\nbeta\n")];

	const result = await scanOutput(chunks);

	assert.equal(result.text, "alpha\nbeta\n");
	assert.equal(result.bytes, 11);
	assert.equal(result.truncation.content, "alpha\nbeta\n");
	assert.equal(result.truncation.totalLines, 2);
	assert.equal(result.truncation.truncated, false);
});

test("truncates output at the line limit", async () => {
	const chunks = [Buffer.from("a\nb\nc\n")];

	const result = await scanOutput(chunks, { maxBytes: 100, maxLines: 2 });

	assert.equal(result.truncation.content, "a\nb");
	assert.equal(result.truncation.outputLines, 2);
	assert.equal(result.truncation.totalLines, 3);
	assert.equal(result.truncation.truncatedBy, "lines");
});

test("truncates output at the byte limit without returning a partial line", async () => {
	const chunks = [Buffer.from("abc\ndef")];

	const result = await scanOutput(chunks, { maxBytes: 5, maxLines: 10 });

	assert.equal(result.truncation.content, "abc");
	assert.equal(result.truncation.outputBytes, 3);
	assert.equal(result.truncation.totalBytes, 7);
	assert.equal(result.truncation.truncatedBy, "bytes");
});

test("identifies a multibyte first line that exceeds the byte limit", async () => {
	const chunks = [Buffer.from("ééé")];

	const result = await scanOutput(chunks, { maxBytes: 5, maxLines: 10 });

	assert.equal(result.bytes, 6);
	assert.equal(result.truncation.content, "");
	assert.equal(result.truncation.firstLineExceedsLimit, true);
	assert.equal(result.truncation.truncatedBy, "bytes");
});

test("does not decode a partial UTF-8 code point at the preview boundary", async () => {
	const chunks = [Buffer.from("123456😀tail")];

	const result = await scanOutput(chunks, { maxBytes: 3, maxLines: 10 });

	assert.equal(result.text, "123456");
	assert.equal(result.truncation.totalBytes, 14);
	assert.equal(result.truncation.firstLineExceedsLimit, true);
});

test("counts CRLF lines without adding an empty trailing line", async () => {
	const chunks = [Buffer.from("a\r\nb\r\n")];

	const result = await scanOutput(chunks);

	assert.equal(result.bytes, 6);
	assert.equal(result.truncation.totalLines, 2);
	assert.equal(result.truncation.content, "a\r\nb\r\n");
});

test("counts the final line when output has no trailing newline", async () => {
	const chunks = [Buffer.from("a\nb")];

	const result = await scanOutput(chunks);

	assert.equal(result.bytes, 3);
	assert.equal(result.truncation.totalLines, 2);
	assert.equal(result.truncation.content, "a\nb");
});

test("keeps a bounded preview for output larger than ten MiB", async () => {
	const chunks = [Buffer.alloc(10_485_761, 0x61)];

	const result = await scanOutput(chunks);

	assert.equal(result.bytes, 10_485_761);
	assert.equal(result.text.length, 51_204);
	assert.equal(result.truncation.totalLines, 1);
	assert.equal(result.truncation.firstLineExceedsLimit, true);
});
