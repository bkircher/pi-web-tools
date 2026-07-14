# pi-web-tools

A pi extension that adds two tools to the
[pi](https://github.com/earendil-works/pi) coding agent: `web_search`, powered
by DuckDuckGo, and `web_fetch`, powered by the
[Obscura](https://github.com/h4ckf0r0day/obscura) headless browser.

## Tools

In pi's interactive TUI, both tools show the request URL and a compact result
summary by default. Press Ctrl+O to expand the full search results or fetched
content. This changes only the display; the complete tool content is still
returned to the model.

### `web_search`

Queries DuckDuckGo's non-JavaScript HTML endpoint and returns result titles,
URLs, and snippets. It does not fetch the result pages.

Parameters:

- `query`: search query, 1–500 characters.
- `limit`: optional number of results to return, 1–20. Defaults to 10.

Use `web_search` for discovery. Its compact summary includes the DuckDuckGo HTTP
status, response HTML size, result count, elapsed time, and cache status.

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
- The extension's private-network preflight protection remains enabled by
  default; however, Obscura's own protection is disabled by `--stealth`.
- Rejects localhost/special-use hostnames, private or reserved IP literals, and
  hostnames that resolve to private or reserved IP addresses before invoking
  Obscura.
- Rejects URLs containing userinfo credentials, query parameters, or fragment
  values that look like credentials or tokens.
- Does not expose `--dump original`; binary/raw downloads should be handled by a
  separate download tool.
- Always passes `--stealth` to Obscura.
- Always passes `--wait` to Obscura. The default post-navigation wait is 5
  seconds; set `wait` to 0 to disable it.
- Its compact summary includes the output mode, dumped output size, elapsed
  time, and truncation status. Obscura's current CLI output does not expose the
  page's HTTP status.

Parameters:

- `url`: required public URL with an `http://` or `https://` scheme. Local or
  private-network hosts, userinfo credentials, and sensitive query parameters or
  fragment values are rejected.
- `dump`: optional output format when `eval` is not used:
  - `markdown` (default)
  - `text`
  - `html`
  - `links`
  - `assets`: subresource URLs from the rendered page in NDJSON format.
- `eval`: optional JavaScript expression evaluated in the rendered page instead
  of dumping page content.
- `selector`: optional CSS selector to wait for before dumping output. Not valid
  with `eval`; use `document.querySelector(...)` inside `eval` instead.
- `waitUntil`: optional readiness condition: `load` (default),
  `domcontentloaded`, `networkidle0`, or `networkidle2`.
- `wait`: optional extra wait after navigation, in seconds. Defaults to 5; the
  valid range is 0–60. Set to 0 to disable the post-navigation wait.
- `timeout`: optional navigation timeout in seconds. Defaults to 30; the valid
  range is 1–120.
- `proxy`: optional HTTP or SOCKS proxy URL passed to Obscura.

Output limits:

- Tool output returned to the model is truncated to pi's standard limit: 2000
  lines or 50.0 KB, whichever comes first.
- If output is truncated, the full Obscura output is left in a per-user
  temporary file and the path is included in the tool result.
- Obscura output is scanned from disk using constant memory; only the bounded
  preview returned to the model is retained in memory.

Usage guidance:

- Use `web_search` to find candidate URLs.
- Use `web_fetch` when the URL is already known or after selecting a search
  result.
- Use `dump=markdown` for most reading or summarization tasks.
- Use `dump=html` only when markup matters.
- Use `dump=links` for page link extraction.
- Use `dump=assets` for rendered subresource URLs.

## Known issues

This extension uses Obscura in `--stealth` mode, which disables checks for
private and internal addresses. Access to those addresses can be used for
exfiltration.

- Host checks are a preflight step only; redirects or later DNS changes can
  still cause Obscura to connect to a different address. Redirect targets should
  be checked separately.
- Reserved-name coverage is not exhaustive; some special-use hostnames and
  IPv4-mapped IPv6 addresses in reserved ranges may not be rejected. Complete
  coverage is difficult to guarantee.
- Sensitive URL detection is heuristic. Query and fragment data is inspected
  through at most two URL-form decoding passes; token-like values hidden more
  deeply inside nested URLs may be missed. Complete detection is difficult to
  guarantee.

Run pi in `sandbox-exec(1)` with Little Snitch, or otherwise isolate it from
private data and infrastructure, to reduce the risk of exfiltration attacks.

## Links

- DuckDuckGo URL parameters:
  <https://duckduckgo.com/duckduckgo-help-pages/settings/params>
- Obscura headless browser: <https://github.com/h4ckf0r0day/obscura>
