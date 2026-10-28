import assert from "node:assert/strict";
import test from "node:test";
import { scan as scanOutput } from "../extensions/web-tools/shared/output.ts";

test("returns metadata for empty output", async () => {
	const chunks: Uint8Array[] = [];

	const result = await scanOutput(chunks);

	assert.equal(result.text, "");
	assert.equal(result.truncation.totalBytes, 0);
	assert.equal(result.truncation.totalLines, 0);
	assert.equal(result.truncated, false);
});

test("preserves output below both limits", async () => {
	const chunks = [Buffer.from("alpha\nbeta\n")];

	const result = await scanOutput(chunks);

	assert.equal(result.text, "alpha\nbeta\n");
	assert.equal(result.truncation.totalBytes, 11);
	assert.equal(result.truncation.content, "alpha\nbeta\n");
	assert.equal(result.truncation.totalLines, 2);
	assert.equal(result.truncated, false);
});

test("truncates output at the line limit", async () => {
	const chunks = [Buffer.from("a\nb\nc\n")];

	const result = await scanOutput(chunks, { maxBytes: 100, maxLines: 2 });

	assert.equal(result.truncation.content, "a\nb");
	assert.equal(result.truncation.outputLines, 2);
	assert.equal(result.truncation.totalLines, 3);
	assert.equal(result.truncation.truncatedBy, "lines");
});

test("truncates output at the byte limit", async () => {
	const chunks = [Buffer.from("abc\ndef")];

	const result = await scanOutput(chunks, { maxBytes: 5, maxLines: 10 });

	assert.equal(result.truncation.content, "abc");
	assert.equal(result.truncation.outputBytes, 3);
	assert.equal(result.truncation.totalBytes, 7);
	assert.equal(result.truncation.truncatedBy, "bytes");
});

test("detects a first line over the byte limit", async () => {
	const chunks = [Buffer.from("ééé")];

	const result = await scanOutput(chunks, { maxBytes: 5, maxLines: 10 });

	assert.equal(result.truncation.totalBytes, 6);
	assert.equal(result.truncation.content, "");
	assert.equal(result.truncation.firstLineExceedsLimit, true);
	assert.equal(result.truncation.truncatedBy, "bytes");
});

test("omits partial UTF-8 characters from previews", async () => {
	const chunks = [Buffer.from("123456😀tail")];

	const result = await scanOutput(chunks, { maxBytes: 3, maxLines: 10 });

	assert.equal(result.text, "123456");
	assert.equal(result.truncation.totalBytes, 14);
	assert.equal(result.truncation.firstLineExceedsLimit, true);
});

test("counts lines with CRLF endings", async () => {
	const chunks = [Buffer.from("a\r\nb\r\n")];

	const result = await scanOutput(chunks);

	assert.equal(result.truncation.totalBytes, 6);
	assert.equal(result.truncation.totalLines, 2);
	assert.equal(result.truncation.content, "a\r\nb\r\n");
});

test("counts lines without a trailing newline", async () => {
	const chunks = [Buffer.from("a\nb")];

	const result = await scanOutput(chunks);

	assert.equal(result.truncation.totalBytes, 3);
	assert.equal(result.truncation.totalLines, 2);
	assert.equal(result.truncation.content, "a\nb");
});

test("limits preview size for large output", async () => {
	const chunks = [Buffer.alloc(10_485_761, 0x61)];

	const result = await scanOutput(chunks);

	assert.equal(result.truncation.totalBytes, 10_485_761);
	assert.equal(result.text.length, 51_204);
	assert.equal(result.truncation.totalLines, 1);
	assert.equal(result.truncation.firstLineExceedsLimit, true);
});
