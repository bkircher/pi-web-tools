const SENSITIVE_FIELD_PATTERN =
	/(?:^|[^a-z0-9])(?:access[-_]?key|access[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|credential|id[-_]?token|jwt|key|pass(?:word|wd)?|pwd|refresh[-_]?token|saml(?:response)?|secret|session(?:id)?|sid|sig(?:nature)?|token)(?:$|[^a-z0-9])/iu;
const SENSITIVE_VALUE_PATTERN =
	/^(?:bearer\s+|(?:[a-z0-9_-]{10,}\.){2}[a-z0-9_-]{10,}|(?:gh[pousr]_|github_pat_|glpat-|sk-[a-z0-9]|xox[baprs]-|AKIA|ASIA|AIza)[a-z0-9_-]{8,})/iu;

// Inspect the serialized component, one ordinary encoding layer, and one extra
// layer for nested or double-encoded values. Deeper encodings are intentionally
// left opaque to keep the heuristic bounded and predictable.
const SENSITIVE_DATA_DECODING_DEPTH = 2;

function decodeComponent(value: string): string {
	// Protect literal separators so URLSearchParams performs one forgiving
	// application/x-www-form-urlencoded decoding pass without splitting fields.
	const encodedSeparators = value.replace(/&/gu, "%26");
	return new URLSearchParams(`value=${encodedSeparators}`).get("value") ?? "";
}

function getNormalizedComponents(value: string): ReadonlyArray<string> {
	const components = [value];
	let current = value;

	for (let depth = 0; depth < SENSITIVE_DATA_DECODING_DEPTH; depth += 1) {
		const decoded = decodeComponent(current);
		if (decoded === current) break;

		components.push(decoded);
		current = decoded;
	}

	return components;
}

function hasSensitiveFieldName(value: string): boolean {
	return SENSITIVE_FIELD_PATTERN.test(value.replace(/([a-z])([A-Z])/g, "$1-$2"));
}

function hasSensitiveValue(value: string): boolean {
	return SENSITIVE_VALUE_PATTERN.test(value.trim());
}

function hasNestedSensitiveData(value: string): boolean {
	return /[?&#=]/u.test(value) && hasSensitiveFieldName(value);
}

function hasSensitiveParam(name: string, value: string): boolean {
	return hasSensitiveFieldName(name) || hasSensitiveValue(value) || hasNestedSensitiveData(value);
}

function hasSensitiveParams(value: string): boolean {
	for (const param of value.split("&")) {
		const separator = param.indexOf("=");
		const name = separator === -1 ? param : param.slice(0, separator);
		const paramValue = separator === -1 ? "" : param.slice(separator + 1);
		if (hasSensitiveParam(name, paramValue)) return true;
	}
	return false;
}

function hasSensitiveParamsAtAnyDepth(value: string): boolean {
	return getNormalizedComponents(value).some(hasSensitiveParams);
}

function getFragmentParams(fragment: string): string {
	const queryStart = fragment.indexOf("?");
	return queryStart === -1 ? fragment : fragment.slice(queryStart + 1);
}

function assertNoSensitiveData(url: URL): void {
	if (url.username || url.password) {
		throw new Error("web_fetch URL must not include username or password credentials");
	}

	if (hasSensitiveParamsAtAnyDepth(url.search.slice(1))) {
		throw new Error("web_fetch URL query must not include credentials or tokens");
	}

	if (!url.hash) return;

	const hasSensitiveFragment = getNormalizedComponents(url.hash.slice(1)).some(
		(fragment) =>
			hasSensitiveFieldName(fragment) ||
			hasSensitiveValue(fragment) ||
			(/[=&?]/u.test(fragment) && hasSensitiveParams(getFragmentParams(fragment))),
	);
	if (hasSensitiveFragment) {
		throw new Error("web_fetch URL fragment must not include credentials or tokens");
	}
}

export function normalizeUrl(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error("Invalid URL");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("web_fetch only supports http:// and https:// URLs");
	}

	assertNoSensitiveData(url);

	return url.href;
}
