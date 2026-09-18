import { MAX_RESULTS } from "./duckduckgo.js";

export const CHALLENGE_SELECTORS = [
	"#challenge-form",
	".anomaly-modal__modal",
	".anomaly-modal__challenge",
	"form[action*='anomaly.js']",
] as const;

// JSON can use six bytes per UTF-16 code unit. A shared 7000-unit budget
// leaves room for fixed fields below the 50 KB evaluation-output limit.
export const DIAGNOSTIC_CHARACTER_BUDGET = 7000;

export function buildSearchEvaluationScript(diagnostics: boolean): string {
	return `(() => {
	const selectors = ${JSON.stringify(CHALLENGE_SELECTORS)};
	const challenge = Boolean(document.querySelector(selectors.join(", ")));
	const links = document.querySelectorAll("a.result__a");
	if (challenge && ${diagnostics}) {
		let remaining = ${DIAGNOSTIC_CHARACTER_BUDGET};
		const sample = (value, limit) => {
			const source = String(value ?? "");
			const text = source.slice(0, Math.min(limit, remaining));
			remaining -= text.length;
			return { text, truncated: text.length < source.length };
		};
		const pageUrl = sample(location.href, 4096);
		try {
			const title = sample(document.title, 256);
			const readyState = sample(document.readyState, 32);
			const matches = selectors.flatMap((selector) => {
				const element = document.querySelector(selector);
				return element ? [{ selector, html: sample(element.outerHTML, 1024) }] : [];
			});
			const pageText = sample(document.body?.textContent, 2048);
			return {
				pageUrl: pageUrl.text,
				challenge,
				results: [],
				evidence: {
					pageUrlTruncated: pageUrl.truncated,
					title,
					readyState,
					resultCount: links.length,
					matches,
					pageText,
				},
			};
		} catch {
			// Keep the challenge result if optional evidence capture fails.
			return { pageUrl: pageUrl.text, challenge, results: [] };
		}
	}
	const results = Array.from(links)
		.slice(0, ${MAX_RESULTS})
		.map((link) => {
			const container = link.closest(".result");
			const snippet = container?.querySelector(".result__snippet");
			return {
				title: link.textContent ?? "",
				href: link.getAttribute("href") ?? "",
				snippet: snippet?.textContent ?? "",
			};
		});
	return { pageUrl: location.href, challenge, results };
})()`;
}
