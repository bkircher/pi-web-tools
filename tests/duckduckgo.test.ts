import assert from "node:assert/strict";
import test from "node:test";
import { parseHtml as parseDuckDuckGoHtml } from "../extensions/web-tools/duckduckgo.ts";

test("extracts decoded titles, snippets, and DuckDuckGo redirect URLs", () => {
	const html = `
		<div class="result web-result">
			<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fx%3D1%26y%3D2&amp;rut=ignored">
				Example &amp; <strong>Docs</strong>
			</a>
			<div class="result__snippet">Read <em>great</em> docs &amp; examples.</div>
		</div>
	`;

	const results = parseDuckDuckGoHtml(html, 20);

	assert.deepEqual(results, [
		{
			title: "Example & Docs",
			url: "https://example.com/docs?x=1&y=2",
			snippet: "Read great docs & examples.",
		},
	]);
});

test("does not borrow a snippet from a neighboring result", () => {
	const html = `
		<div class="result">
			<a class="result__a" href="https://first.example/">First</a>
		</div>
		<div class="result">
			<a class="result__a" href="https://second.example/">Second</a>
			<div class="result__snippet">Second snippet</div>
		</div>
	`;

	const results = parseDuckDuckGoHtml(html, 20);

	assert.deepEqual(results, [
		{ title: "First", url: "https://first.example/" },
		{ title: "Second", url: "https://second.example/", snippet: "Second snippet" },
	]);
});

test("does not unwrap uddg parameters on non-DuckDuckGo URLs", () => {
	const html = `
		<div class="result">
			<a class="result__a" href="https://example.com/?uddg=https%3A%2F%2Fevil.example%2F">Example</a>
		</div>
	`;

	const results = parseDuckDuckGoHtml(html, 20);

	assert.deepEqual(results, [
		{
			title: "Example",
			url: "https://example.com/?uddg=https%3A%2F%2Fevil.example%2F",
		},
	]);
});

test("extracts results from malformed but recoverable HTML", () => {
	const html = `
		<div class=result>
			<a class=result__a href=https://example.com>Broken <b>title</b></a>
			<div class=result__snippet>Useful <i>text
	`;

	const results = parseDuckDuckGoHtml(html, 20);

	assert.deepEqual(results, [
		{
			title: "Broken title",
			url: "https://example.com/",
			snippet: "Useful text",
		},
	]);
});

test("stops collecting results at the requested limit", () => {
	const html = `
		<div class="result"><a class="result__a" href="https://one.example/">One</a></div>
		<div class="result"><a class="result__a" href="https://two.example/">Two</a></div>
		<div class="result"><a class="result__a" href="https://three.example/">Three</a></div>
	`;

	const results = parseDuckDuckGoHtml(html, 2);

	assert.deepEqual(results, [
		{ title: "One", url: "https://one.example/" },
		{ title: "Two", url: "https://two.example/" },
	]);
});

test("omits duplicate and non-HTTP result URLs", () => {
	const html = `
		<div class="result"><a class="result__a" href="https://example.com/">First</a></div>
		<div class="result"><a class="result__a" href="https://example.com/">Duplicate</a></div>
		<div class="result"><a class="result__a" href="javascript:alert(1)">Script</a></div>
	`;

	const results = parseDuckDuckGoHtml(html, 20);

	assert.deepEqual(results, [{ title: "First", url: "https://example.com/" }]);
});
