import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

type IpVersion = "ipv4" | "ipv6";

export type WebFetchHostResolver = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

const BLOCKED_WEB_FETCH_IP_RANGES: Array<{ address: string; prefix: number; version: IpVersion }> = [
	{ address: "0.0.0.0", prefix: 8, version: "ipv4" },
	{ address: "10.0.0.0", prefix: 8, version: "ipv4" },
	{ address: "100.64.0.0", prefix: 10, version: "ipv4" },
	{ address: "127.0.0.0", prefix: 8, version: "ipv4" },
	{ address: "169.254.0.0", prefix: 16, version: "ipv4" },
	{ address: "172.16.0.0", prefix: 12, version: "ipv4" },
	{ address: "192.0.0.0", prefix: 24, version: "ipv4" },
	{ address: "192.0.2.0", prefix: 24, version: "ipv4" },
	{ address: "192.88.99.0", prefix: 24, version: "ipv4" },
	{ address: "192.168.0.0", prefix: 16, version: "ipv4" },
	{ address: "198.18.0.0", prefix: 15, version: "ipv4" },
	{ address: "198.51.100.0", prefix: 24, version: "ipv4" },
	{ address: "203.0.113.0", prefix: 24, version: "ipv4" },
	{ address: "224.0.0.0", prefix: 4, version: "ipv4" },
	{ address: "240.0.0.0", prefix: 4, version: "ipv4" },
	{ address: "::", prefix: 96, version: "ipv6" },
	{ address: "64:ff9b::", prefix: 96, version: "ipv6" },
	{ address: "64:ff9b:1::", prefix: 48, version: "ipv6" },
	{ address: "100::", prefix: 64, version: "ipv6" },
	{ address: "2001::", prefix: 32, version: "ipv6" },
	{ address: "2001:2::", prefix: 48, version: "ipv6" },
	{ address: "2001:10::", prefix: 28, version: "ipv6" },
	{ address: "2001:db8::", prefix: 32, version: "ipv6" },
	{ address: "2002::", prefix: 16, version: "ipv6" },
	{ address: "fc00::", prefix: 7, version: "ipv6" },
	{ address: "fe80::", prefix: 10, version: "ipv6" },
	{ address: "fec0::", prefix: 10, version: "ipv6" },
	{ address: "ff00::", prefix: 8, version: "ipv6" },
];

const BLOCKED_WEB_FETCH_IPS = new BlockList();
for (const { address, prefix, version } of BLOCKED_WEB_FETCH_IP_RANGES) {
	BLOCKED_WEB_FETCH_IPS.addSubnet(address, prefix, version);
}

const SPECIAL_USE_WEB_FETCH_HOSTNAMES = ["localhost", "local", "home.arpa", "internal"] as const;

const SENSITIVE_URL_FIELD_NAME_PATTERN =
	/(?:^|[^a-z0-9])(?:access[-_]?key|access[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|credential|id[-_]?token|jwt|key|pass(?:word|wd)?|pwd|refresh[-_]?token|saml(?:response)?|secret|session(?:id)?|sid|sig(?:nature)?|token)(?:$|[^a-z0-9])/iu;
const SENSITIVE_URL_VALUE_PATTERN =
	/^(?:bearer\s+|(?:[a-z0-9_-]{10,}\.){2}[a-z0-9_-]{10,}|(?:gh[pousr]_|github_pat_|glpat-|sk-[a-z0-9]|xox[baprs]-|AKIA|ASIA|AIza)[a-z0-9_-]{8,})/iu;

function unbracketHostname(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function stripTrailingDots(hostname: string): string {
	return hostname.replace(/\.+$/u, "");
}

function getIpVersion(address: string): IpVersion | undefined {
	const version = isIP(unbracketHostname(address));
	if (version === 4) return "ipv4";
	if (version === 6) return "ipv6";
	return undefined;
}

function getEmbeddedIpv4FromMappedIpv6(address: string): string | undefined {
	const normalizedAddress = unbracketHostname(address);
	if (isIP(normalizedAddress) !== 6) return undefined;

	let canonicalAddress: string;
	try {
		canonicalAddress = unbracketHostname(new URL(`http://[${normalizedAddress}]/`).hostname).toLowerCase();
	} catch {
		canonicalAddress = normalizedAddress.toLowerCase();
	}

	const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonicalAddress);
	if (!match) return undefined;

	const high = Number.parseInt(match[1], 16);
	const low = Number.parseInt(match[2], 16);
	return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function isBlockedWebFetchIp(address: string): boolean {
	const normalizedAddress = unbracketHostname(address);
	const version = getIpVersion(normalizedAddress);
	if (version === undefined) return false;

	if (version === "ipv6") {
		const embeddedIpv4Address = getEmbeddedIpv4FromMappedIpv6(normalizedAddress);
		if (embeddedIpv4Address && BLOCKED_WEB_FETCH_IPS.check(embeddedIpv4Address, "ipv4")) {
			return true;
		}
	}

	return BLOCKED_WEB_FETCH_IPS.check(normalizedAddress, version);
}

function isSpecialUseWebFetchHostname(hostname: string): boolean {
	const normalizedHostname = stripTrailingDots(unbracketHostname(hostname)).toLowerCase();
	return SPECIAL_USE_WEB_FETCH_HOSTNAMES.some(
		(suffix) => normalizedHostname === suffix || normalizedHostname.endsWith(`.${suffix}`),
	);
}

function safelyDecodeUrlComponent(value: string): string {
	try {
		return decodeURIComponent(value.replace(/\+/gu, " "));
	} catch {
		return value;
	}
}

function containsSensitiveUrlFieldName(value: string): boolean {
	const decodedValue = safelyDecodeUrlComponent(value);
	const normalizedValue = decodedValue.replace(/([a-z])([A-Z])/g, "$1-$2");
	return SENSITIVE_URL_FIELD_NAME_PATTERN.test(normalizedValue);
}

function containsSensitiveUrlValue(value: string): boolean {
	return SENSITIVE_URL_VALUE_PATTERN.test(value.trim());
}

function containsNestedSensitiveUrlData(value: string): boolean {
	const decodedValue = safelyDecodeUrlComponent(value);
	return /[?&#=]/u.test(decodedValue) && containsSensitiveUrlFieldName(decodedValue);
}

function containsSensitiveUrlParam(name: string, value: string): boolean {
	return (
		containsSensitiveUrlFieldName(name) || containsSensitiveUrlValue(value) || containsNestedSensitiveUrlData(value)
	);
}

function containsSensitiveUrlParams(params: Iterable<[string, string]>): boolean {
	for (const [name, value] of params) {
		if (containsSensitiveUrlParam(name, value)) return true;
	}

	return false;
}

function getFragmentUrlParams(fragment: string): URLSearchParams {
	const queryStart = fragment.indexOf("?");
	return new URLSearchParams(queryStart === -1 ? fragment : fragment.slice(queryStart + 1));
}

function assertNoSensitiveUrlData(url: URL): void {
	if (url.username || url.password) {
		throw new Error("web_fetch URL must not include username or password credentials");
	}

	if (containsSensitiveUrlParams(url.searchParams)) {
		throw new Error("web_fetch URL query must not include credentials or tokens");
	}

	if (!url.hash) return;

	const fragment = safelyDecodeUrlComponent(url.hash.slice(1));
	if (
		containsSensitiveUrlFieldName(fragment) ||
		containsSensitiveUrlValue(fragment) ||
		(/[=&?]/u.test(fragment) && containsSensitiveUrlParams(getFragmentUrlParams(fragment)))
	) {
		throw new Error("web_fetch URL fragment must not include credentials or tokens");
	}
}

async function resolveWebFetchHost(hostname: string): Promise<ReadonlyArray<{ address: string }>> {
	return lookup(hostname, { all: true, verbatim: true });
}

async function assertPublicWebFetchHost(url: URL, resolveHost: WebFetchHostResolver): Promise<void> {
	const hostname = stripTrailingDots(unbracketHostname(url.hostname)).toLowerCase();
	if (!hostname) {
		throw new Error("web_fetch URL must include a hostname");
	}

	if (isSpecialUseWebFetchHostname(hostname)) {
		throw new Error("web_fetch URL must not target localhost or other special-use hostnames");
	}

	if (isBlockedWebFetchIp(hostname)) {
		throw new Error("web_fetch URL must not target private, local, or reserved IP addresses");
	}

	if (getIpVersion(hostname)) return;

	let addresses: ReadonlyArray<{ address: string }>;
	try {
		addresses = await resolveHost(hostname);
	} catch {
		throw new Error("web_fetch URL hostname could not be resolved");
	}

	if (addresses.length === 0) {
		throw new Error("web_fetch URL hostname did not resolve to any addresses");
	}

	if (addresses.some(({ address }) => isBlockedWebFetchIp(address))) {
		throw new Error("web_fetch URL hostname resolves to a private, local, or reserved IP address");
	}
}

export async function normalizeWebFetchUrl(
	input: string,
	resolveHost: WebFetchHostResolver = resolveWebFetchHost,
): Promise<string> {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error("Invalid URL");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("web_fetch only supports http:// and https:// URLs");
	}

	assertNoSensitiveUrlData(url);
	await assertPublicWebFetchHost(url, resolveHost);

	return url.href;
}
