import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUrl, type Resolver } from "../extensions/web-tools/fetch-url-policy.ts";

const resolvePublicHost: Resolver = async () => [{ address: "93.184.216.34" }];

test("normalizes public HTTP URLs", async () => {
	const input = "https://Example.COM:443/docs?q=public#section";

	const result = await normalizeUrl(input, resolvePublicHost);

	assert.equal(result, "https://example.com/docs?q=public#section");
});

test("rejects URL credentials", async () => {
	const input = "https://user:password@example.com/docs";

	const result = normalizeUrl(input, resolvePublicHost);

	await assert.rejects(result, { message: "web_fetch URL must not include username or password credentials" });
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
	test(`rejects ${name}`, async () => {
		const result = normalizeUrl(input, resolvePublicHost);

		await assert.rejects(result, { message: expectedMessage });
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
	test(`allows ${name}`, async () => {
		const result = await normalizeUrl(input, resolvePublicHost);

		assert.equal(result, input);
	});
}

test("rejects special-use hostnames before DNS resolution", async () => {
	const input = "https://service.local/docs";

	const result = normalizeUrl(input, resolvePublicHost);

	await assert.rejects(result, { message: "web_fetch URL must not target localhost or other special-use hostnames" });
});

test("rejects private IP literals", async () => {
	const input = "http://192.168.1.1/docs";

	const result = normalizeUrl(input, resolvePublicHost);

	await assert.rejects(result, { message: "web_fetch URL must not target private, local, or reserved IP addresses" });
});

test("rejects hostnames when any resolved address is private", async () => {
	const resolveMixedHost: Resolver = async () => [{ address: "93.184.216.34" }, { address: "10.0.0.1" }];

	const result = normalizeUrl("https://example.com/docs", resolveMixedHost);

	await assert.rejects(result, {
		message: "web_fetch URL hostname resolves to a private, local, or reserved IP address",
	});
});
