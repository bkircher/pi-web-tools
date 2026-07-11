import { parse, type DefaultTreeAdapterTypes } from "parse5";

export type SearchResult = {
	title: string;
	url: string;
	snippet?: string;
};

type Node = DefaultTreeAdapterTypes.Node;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;

function isElement(node: Node): node is Element {
	return "tagName" in node;
}

function isTextNode(node: Node): node is TextNode {
	return !isElement(node) && node.nodeName === "#text";
}

function getAttribute(element: Element, name: string): string | undefined {
	return element.attrs.find((attribute) => attribute.name === name)?.value;
}

function hasClass(element: Element, className: string): boolean {
	return getAttribute(element, "class")?.split(/\s+/u).includes(className) ?? false;
}

function pushChildrenInReverse(stack: Node[], node: ParentNode): void {
	for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
		stack.push(node.childNodes[index]);
	}
}

function* walkElements(root: ParentNode): Generator<Element> {
	const stack: Node[] = [];
	pushChildrenInReverse(stack, root);

	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) break;

		if (isElement(node)) {
			yield node;
			pushChildrenInReverse(stack, node);
		}
	}
}

function findFirstElement(root: ParentNode, predicate: (element: Element) => boolean): Element | undefined {
	for (const element of walkElements(root)) {
		if (predicate(element)) return element;
	}
	return undefined;
}

function findClosestResultContainer(element: Element): Element | undefined {
	let parent = element.parentNode;
	while (parent) {
		if (isElement(parent) && hasClass(parent, "result")) return parent;
		parent = "parentNode" in parent ? parent.parentNode : null;
	}
	return undefined;
}

function textContent(root: ParentNode): string {
	const parts: string[] = [];
	const stack: Node[] = [];
	pushChildrenInReverse(stack, root);

	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) break;

		if (isTextNode(node)) {
			parts.push(node.value);
			continue;
		}
		if (isElement(node) && (node.tagName === "script" || node.tagName === "style")) continue;
		if (isElement(node)) pushChildrenInReverse(stack, node);
	}

	return parts.join("").replace(/\s+/gu, " ").trim();
}

function unwrapDuckDuckGoUrl(href: string): string | undefined {
	let url: URL;
	try {
		url = new URL(href, "https://html.duckduckgo.com");
	} catch {
		return undefined;
	}

	const isDuckDuckGoRedirect =
		(url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) && url.pathname === "/l/";
	const uddg = isDuckDuckGoRedirect ? url.searchParams.get("uddg") : undefined;
	if (uddg) {
		try {
			url = new URL(uddg);
		} catch {
			return undefined;
		}
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	return url.href;
}

export function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
	if (maxResults <= 0) return [];

	const document = parse(html);
	const results: SearchResult[] = [];
	const seen = new Set<string>();

	for (const link of walkElements(document)) {
		if (link.tagName !== "a" || !hasClass(link, "result__a")) continue;
		const href = getAttribute(link, "href");
		const url = href ? unwrapDuckDuckGoUrl(href) : undefined;
		const title = textContent(link);
		if (!title || !url || seen.has(url)) continue;

		const container = findClosestResultContainer(link);
		const snippetElement = container
			? findFirstElement(container, (element) => hasClass(element, "result__snippet"))
			: undefined;
		const snippet = snippetElement ? textContent(snippetElement) : undefined;

		seen.add(url);
		results.push({
			title,
			url,
			...(snippet ? { snippet } : {}),
		});
		if (results.length >= maxResults) break;
	}

	return results;
}
