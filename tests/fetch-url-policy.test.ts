import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWebFetchUrl, type WebFetchHostResolver } from "../extensions/web-tools/fetch-url-policy.ts";

const resolvePublicHost: WebFetchHostResolver = async () => [{ address: "93.184.216.34" }];

test("normalizes public HTTP URLs", async () => {
	const input = "https://Example.COM:443/docs?q=public#section";

	const result = await normalizeWebFetchUrl(input, resolvePublicHost);

	assert.equal(result, "https://example.com/docs?q=public#section");
});

test("rejects URL credentials", async () => {
	const input = "https://user:password@example.com/docs";

	const result = normalizeWebFetchUrl(input, resolvePublicHost);

	await assert.rejects(result, { message: "web_fetch URL must not include username or password credentials" });
});

test("rejects sensitive URL query parameters", async () => {
	const input = "https://example.com/docs?access_token=secret-value";

	const result = normalizeWebFetchUrl(input, resolvePublicHost);

	await assert.rejects(result, { message: "web_fetch URL query must not include credentials or tokens" });
});

test("rejects special-use hostnames before DNS resolution", async () => {
	const input = "https://service.local/docs";

	const result = normalizeWebFetchUrl(input, resolvePublicHost);

	await assert.rejects(result, { message: "web_fetch URL must not target localhost or other special-use hostnames" });
});

test("rejects private IP literals", async () => {
	const input = "http://192.168.1.1/docs";

	const result = normalizeWebFetchUrl(input, resolvePublicHost);

	await assert.rejects(result, { message: "web_fetch URL must not target private, local, or reserved IP addresses" });
});

test("rejects hostnames when any resolved address is private", async () => {
	const resolveMixedHost: WebFetchHostResolver = async () => [{ address: "93.184.216.34" }, { address: "10.0.0.1" }];

	const result = normalizeWebFetchUrl("https://example.com/docs", resolveMixedHost);

	await assert.rejects(result, {
		message: "web_fetch URL hostname resolves to a private, local, or reserved IP address",
	});
});
