import assert from "node:assert/strict";
import test from "node:test";
import {
	normalizeResults as normalizeDuckDuckGoResults,
	normalizeResultUrl,
} from "../extensions/web-tools/search/duckduckgo.ts";

test("normalizes result text and DuckDuckGo redirect URLs", () => {
	const rawResults = [
		{
			title: "  Example \n Docs  ",
			href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fx%3D1%26y%3D2&rut=ignored",
			snippet: " Read\tgreat docs. ",
		},
	];

	const results = normalizeDuckDuckGoResults(rawResults, 20);

	assert.deepEqual(results, [
		{
			title: "Example Docs",
			url: "https://example.com/docs?x=1&y=2",
			snippet: "Read great docs.",
		},
	]);
});

test("does not unwrap uddg parameters on non-DuckDuckGo URLs", () => {
	const href = "https://example.com/?uddg=https%3A%2F%2Fevil.example%2F";

	const result = normalizeResultUrl(href);

	assert.equal(result, "https://example.com/?uddg=https%3A%2F%2Fevil.example%2F");
});

test("does not unwrap DuckDuckGo links outside the redirect path", () => {
	const href = "https://duckduckgo.com/search/?uddg=https%3A%2F%2Fevil.example%2F";

	const result = normalizeResultUrl(href);

	assert.equal(result, "https://duckduckgo.com/search/?uddg=https%3A%2F%2Fevil.example%2F");
});

test("stops collecting results at the requested limit", () => {
	const rawResults = [
		{ title: "One", href: "https://one.example/" },
		{ title: "Two", href: "https://two.example/" },
		{ title: "Three", href: "https://three.example/" },
	];

	const results = normalizeDuckDuckGoResults(rawResults, 2);

	assert.deepEqual(results, [
		{ title: "One", url: "https://one.example/" },
		{ title: "Two", url: "https://two.example/" },
	]);
});

test("omits duplicate, unsafe, and empty results", () => {
	const rawResults = [
		{ title: "First", href: "https://example.com/" },
		{ title: "Duplicate", href: "https://example.com/" },
		{ title: "Script", href: "javascript:alert(1)" },
		{ title: "Mail", href: "mailto:test@example.com" },
		{ title: "Empty link", href: "  " },
		{ title: "", href: "https://empty.example/" },
	];

	const results = normalizeDuckDuckGoResults(rawResults, 20);

	assert.deepEqual(results, [{ title: "First", url: "https://example.com/" }]);
});
