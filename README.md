# pi-web-tools

A pi extension that adds the `web_search` DuckDuckGo tool and the `web_fetch`
[Obscura](https://github.com/h4ckf0r0day/obscura) headless-browser tool to the
[pi](https://github.com/earendil-works/pi) coding agent.

## Tools

### `web_search`

Queries DuckDuckGo's non-JavaScript HTML endpoint and returns result titles,
URLs, and snippets. It does not fetch the result pages.

Parameters:

- `query`: search query, 1-500 characters.
- `limit`: optional number of results to return, 1-20. Defaults to 10.

Use `web_search` for discovery.

### `web_fetch`

Fetches a specific URL with the
[`obscura`](https://github.com/h4ckf0r0day/obscura) CLI, which must be installed
and available on `PATH`.

Behavior:

- Defaults to `--dump markdown`, which keeps headings, lists, and links while
  avoiding most HTML noise.
- Uses `--quiet` and `--output` so the tool controls output size consistently.
- Supports JavaScript-rendered pages through Obscura. Use `eval` to inspect
  rendered page content.
- Obscura's private-network protection remains enabled by default; this tool
  does not pass `--allow-private-network`.
- Rejects localhost/special-use hostnames, private or reserved IP literals, and
  hostnames that resolve to private or reserved IP addresses before invoking
  Obscura.
- Rejects URLs containing userinfo credentials or query/fragment fields that
  look like credentials or tokens.
- Does not expose `--dump original`; binary/raw downloads should be handled by a
  separate download tool.
- Always passes `--stealth` to Obscura.
- Always passes `--wait` to Obscura. The default post-navigation wait is 5
  seconds; set `wait` to 0 to disable it.

Parameters:

- `url`: required public URL with an `http://` or `https://` scheme. Local or
  private-network hosts, userinfo credentials, and sensitive query/fragment
  tokens are rejected.
- `dump`: optional output format when `eval` is not used:
  - `markdown` (default)
  - `text`
  - `html`
  - `links`
  - `assets`: NDJSON subresource URLs from the rendered page.
- `eval`: optional JavaScript expression evaluated in the rendered page instead
  of dumping page content.
- `selector`: optional CSS selector to wait for before dumping output. Not valid
  with `eval`; use `document.querySelector(...)` inside `eval` instead.
- `waitUntil`: optional readiness condition: `load` (default),
  `domcontentloaded`, `networkidle0`, or `networkidle2`.
- `wait`: optional extra wait after navigation, in seconds. Defaults to 5;
  maximum 60. Set to 0 to disable the post-navigation wait.
- `timeout`: optional navigation timeout in seconds. Defaults to 30; valid range
  1-120.
- `proxy`: optional HTTP or SOCKS proxy URL passed to Obscura.

Output limits:

- Tool output returned to the model is truncated to pi's standard limit: 2000
  lines or 50.0KB, whichever comes first.
- If output is truncated, the full Obscura output is left in a per-user
  temporary file and the path is included in the tool result.
- If the Obscura output is larger than 10 MiB, the tool reads only a small
  preview and keeps the full output file.

Usage guidance:

- Use `web_search` to find candidate URLs.
- Use `web_fetch` when the URL is already known or after selecting a search
  result.
- Use `dump=markdown` for most reading or summarization tasks.
- Use `dump=html` only when markup matters.
- Use `dump=links` for page link extraction.
- Use `dump=assets` for rendered subresource URLs.

## Known issues

This extension uses Obscura in `--stealth` mode, which disables checking for
private and internal addresses that can be used for exfiltration.

- Host checks are a preflight step only; redirects or later DNS changes can
  still point Obscura at a different address. Redirect targets should be checked
  separately.
- Reserved-name coverage is not exhaustive; some special-use hostnames and
  IPv4-mapped IPv6 reserved ranges may not be rejected. Complete coverage is
  difficult to guarantee.
- Sensitive URL detection is heuristic; token-like values hidden inside encoded
  nested URLs may be missed. Complete detection is difficult to guarantee.

Run pi in `sandbox-exec(1)` with Little Snitch, or otherwise isolate it from
private data and infrastructure, to reduce the risk of exfiltration attacks.

## Links

- DuckDuckGo URL parameters:
  <https://duckduckgo.com/duckduckgo-help-pages/settings/params>
- Obscura headless browser: <https://github.com/h4ckf0r0day/obscura>
