import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUrl } from "../extensions/web-tools/fetch/url-policy.ts";

test("normalizes public HTTPS URLs", () => {
	const input = "https://Example.COM:443/docs?q=public#section";

	const result = normalizeUrl(input);

	assert.equal(result, "https://example.com/docs?q=public#section");
});

test("rejects URL credentials", () => {
	const input = "https://user:password@example.com/docs";

	const normalize = () => normalizeUrl(input);

	assert.throws(normalize, { message: "web_fetch URL must not include username or password credentials" });
});

const sensitiveUrlCases = [
	{
		name: "plain query field names",
		input: "https://example.com/docs?access_token=secret-value",
		expectedMessage: "web_fetch URL query must not include credentials or tokens",
	},
	{
		name: "encoded query field names",
		input: "https://example.com/docs?access%5Ftoken=secret-value",
		expectedMessage: "web_fetch URL query must not include credentials or tokens",
	},
	{
		name: "double-encoded query field names",
		input: "https://example.com/docs?access%255Ftoken=secret-value",
		expectedMessage: "web_fetch URL query must not include credentials or tokens",
	},
	{
		name: "encoded query fields alongside malformed escapes",
		input: "https://example.com/docs?ignored=%&access%5Ftoken=secret-value",
		expectedMessage: "web_fetch URL query must not include credentials or tokens",
	},
	{
		name: "encoded token-like query values",
		input: "https://example.com/docs?value=%67hp_1234567890",
		expectedMessage: "web_fetch URL query must not include credentials or tokens",
	},
	{
		name: "sensitive fields in encoded nested query URLs",
		input: "https://example.com/docs?redirect=https%3A%2F%2Fclient.example%2Fcallback%3Faccess%5Ftoken%3Dsecret-value",
		expectedMessage: "web_fetch URL query must not include credentials or tokens",
	},
	{
		name: "sensitive fields in double-encoded nested query URLs",
		input: "https://example.com/docs?redirect=https%253A%252F%252Fclient.example%252Fcallback%253Faccess%255Ftoken%253Dsecret-value",
		expectedMessage: "web_fetch URL query must not include credentials or tokens",
	},
	{
		name: "plain fragment field names",
		input: "https://example.com/docs#access_token=secret-value",
		expectedMessage: "web_fetch URL fragment must not include credentials or tokens",
	},
	{
		name: "encoded fragment field names",
		input: "https://example.com/docs#access%5Ftoken%3Dsecret-value",
		expectedMessage: "web_fetch URL fragment must not include credentials or tokens",
	},
	{
		name: "double-encoded fragment field names",
		input: "https://example.com/docs#access%255Ftoken%253Dsecret-value",
		expectedMessage: "web_fetch URL fragment must not include credentials or tokens",
	},
	{
		name: "sensitive fields in encoded nested fragment URLs",
		input: "https://example.com/docs#callback?redirect=https%3A%2F%2Fclient.example%2F%3Faccess%5Ftoken%3Dsecret-value",
		expectedMessage: "web_fetch URL fragment must not include credentials or tokens",
	},
] as const;

for (const { name, input, expectedMessage } of sensitiveUrlCases) {
	test(`rejects ${name}`, () => {
		const normalize = () => normalizeUrl(input);

		assert.throws(normalize, { message: expectedMessage });
	});
}

const allowedSensitiveLookingUrlCases = [
	{
		name: "non-field query values",
		input: "https://example.com/docs?q=access_token",
	},
	{
		name: "query data beyond two decoding layers",
		input: "https://example.com/docs?access%25255Ftoken=public",
	},
	{
		name: "fragment data beyond two decoding layers",
		input: "https://example.com/docs#access%25255Ftoken%25253Dpublic",
	},
] as const;

for (const { name, input } of allowedSensitiveLookingUrlCases) {
	test(`allows ${name}`, () => {
		const result = normalizeUrl(input);

		assert.equal(result, input);
	});
}

test("rejects malformed URLs", () => {
	const input = "not a URL";

	const normalize = () => normalizeUrl(input);

	assert.throws(normalize, { message: "Invalid URL" });
});

test("rejects file URLs", () => {
	const input = "file:///Users/example/notes.txt";

	const normalize = () => normalizeUrl(input);

	assert.throws(normalize, { message: "web_fetch only supports http:// and https:// URLs" });
});

test("rejects FTP URLs", () => {
	const input = "ftp://example.com/docs";

	const normalize = () => normalizeUrl(input);

	assert.throws(normalize, { message: "web_fetch only supports http:// and https:// URLs" });
});

test("normalizes HTTP URLs without DNS resolution", () => {
	const input = "http://Unresolvable.INVALID:80/docs";

	const result = normalizeUrl(input);

	assert.equal(result, "http://unresolvable.invalid/docs");
});

test("leaves special-use hostname restrictions to Obscura", () => {
	const input = "https://service.local/docs";

	const result = normalizeUrl(input);

	assert.equal(result, "https://service.local/docs");
});

test("leaves localhost restrictions to Obscura", () => {
	const input = "http://localhost:8080/docs";

	const result = normalizeUrl(input);

	assert.equal(result, "http://localhost:8080/docs");
});

test("leaves private IPv4 restrictions to Obscura", () => {
	const input = "http://192.168.1.1/docs";

	const result = normalizeUrl(input);

	assert.equal(result, "http://192.168.1.1/docs");
});

test("leaves IPv6 loopback restrictions to Obscura", () => {
	const input = "http://[::1]/docs";

	const result = normalizeUrl(input);

	assert.equal(result, "http://[::1]/docs");
});

test("normalizes IPv4-mapped IPv6 URLs for Obscura", () => {
	const input = "http://[::ffff:192.168.1.1]/docs";

	const result = normalizeUrl(input);

	assert.equal(result, "http://[::ffff:c0a8:101]/docs");
});
