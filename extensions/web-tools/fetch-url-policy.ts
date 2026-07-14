import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

type IpVersion = "ipv4" | "ipv6";

export type Resolver = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

const BLOCKED_IP_RANGES: Array<{ address: string; prefix: number; version: IpVersion }> = [
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

const BLOCKED_IPS = new BlockList();
for (const { address, prefix, version } of BLOCKED_IP_RANGES) {
	BLOCKED_IPS.addSubnet(address, prefix, version);
}

const SPECIAL_USE_HOSTNAMES = ["localhost", "local", "home.arpa", "internal"] as const;

const SENSITIVE_FIELD_PATTERN =
	/(?:^|[^a-z0-9])(?:access[-_]?key|access[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|credential|id[-_]?token|jwt|key|pass(?:word|wd)?|pwd|refresh[-_]?token|saml(?:response)?|secret|session(?:id)?|sid|sig(?:nature)?|token)(?:$|[^a-z0-9])/iu;
const SENSITIVE_VALUE_PATTERN =
	/^(?:bearer\s+|(?:[a-z0-9_-]{10,}\.){2}[a-z0-9_-]{10,}|(?:gh[pousr]_|github_pat_|glpat-|sk-[a-z0-9]|xox[baprs]-|AKIA|ASIA|AIza)[a-z0-9_-]{8,})/iu;

function stripBrackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function normalizeHostname(hostname: string): string {
	return stripBrackets(hostname).replace(/\.+$/u, "").toLowerCase();
}

function getIpVersion(address: string): IpVersion | undefined {
	const version = isIP(stripBrackets(address));
	if (version === 4) return "ipv4";
	if (version === 6) return "ipv6";
	return undefined;
}

function getMappedIpv4(address: string): string | undefined {
	const normalized = stripBrackets(address);
	if (isIP(normalized) !== 6) return undefined;

	let canonical: string;
	try {
		canonical = stripBrackets(new URL(`http://[${normalized}]/`).hostname).toLowerCase();
	} catch {
		canonical = normalized.toLowerCase();
	}

	const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonical);
	if (!match) return undefined;

	const high = Number.parseInt(match[1], 16);
	const low = Number.parseInt(match[2], 16);
	return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function isBlockedIp(address: string): boolean {
	const normalized = stripBrackets(address);
	const version = getIpVersion(normalized);
	if (version === undefined) return false;

	if (version === "ipv6") {
		const mappedIpv4 = getMappedIpv4(normalized);
		if (mappedIpv4 && BLOCKED_IPS.check(mappedIpv4, "ipv4")) return true;
	}

	return BLOCKED_IPS.check(normalized, version);
}

function isSpecialUseHostname(hostname: string): boolean {
	const normalized = normalizeHostname(hostname);
	return SPECIAL_USE_HOSTNAMES.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function decodeComponent(value: string): string {
	try {
		return decodeURIComponent(value.replace(/\+/gu, " "));
	} catch {
		return value;
	}
}

function hasSensitiveFieldName(value: string): boolean {
	const decoded = decodeComponent(value);
	return SENSITIVE_FIELD_PATTERN.test(decoded.replace(/([a-z])([A-Z])/g, "$1-$2"));
}

function hasSensitiveValue(value: string): boolean {
	return SENSITIVE_VALUE_PATTERN.test(value.trim());
}

function hasNestedSensitiveData(value: string): boolean {
	const decoded = decodeComponent(value);
	return /[?&#=]/u.test(decoded) && hasSensitiveFieldName(decoded);
}

function hasSensitiveParam(name: string, value: string): boolean {
	return hasSensitiveFieldName(name) || hasSensitiveValue(value) || hasNestedSensitiveData(value);
}

function hasSensitiveParams(params: Iterable<[string, string]>): boolean {
	for (const [name, value] of params) {
		if (hasSensitiveParam(name, value)) return true;
	}
	return false;
}

function getFragmentParams(fragment: string): URLSearchParams {
	const queryStart = fragment.indexOf("?");
	return new URLSearchParams(queryStart === -1 ? fragment : fragment.slice(queryStart + 1));
}

function assertNoSensitiveData(url: URL): void {
	if (url.username || url.password) {
		throw new Error("web_fetch URL must not include username or password credentials");
	}

	if (hasSensitiveParams(url.searchParams)) {
		throw new Error("web_fetch URL query must not include credentials or tokens");
	}

	if (!url.hash) return;

	const fragment = decodeComponent(url.hash.slice(1));
	if (
		hasSensitiveFieldName(fragment) ||
		hasSensitiveValue(fragment) ||
		(/[=&?]/u.test(fragment) && hasSensitiveParams(getFragmentParams(fragment)))
	) {
		throw new Error("web_fetch URL fragment must not include credentials or tokens");
	}
}

async function resolveHost(hostname: string): Promise<ReadonlyArray<{ address: string }>> {
	return lookup(hostname, { all: true, verbatim: true });
}

async function assertPublicHost(url: URL, resolver: Resolver): Promise<void> {
	const hostname = normalizeHostname(url.hostname);
	if (!hostname) {
		throw new Error("web_fetch URL must include a hostname");
	}

	if (isSpecialUseHostname(hostname)) {
		throw new Error("web_fetch URL must not target localhost or other special-use hostnames");
	}

	if (isBlockedIp(hostname)) {
		throw new Error("web_fetch URL must not target private, local, or reserved IP addresses");
	}

	if (getIpVersion(hostname)) return;

	let addresses: ReadonlyArray<{ address: string }>;
	try {
		addresses = await resolver(hostname);
	} catch {
		throw new Error("web_fetch URL hostname could not be resolved");
	}

	if (addresses.length === 0) {
		throw new Error("web_fetch URL hostname did not resolve to any addresses");
	}

	if (addresses.some(({ address }) => isBlockedIp(address))) {
		throw new Error("web_fetch URL hostname resolves to a private, local, or reserved IP address");
	}
}

export async function normalizeUrl(input: string, resolver: Resolver = resolveHost): Promise<string> {
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
	await assertPublicHost(url, resolver);

	return url.href;
}
