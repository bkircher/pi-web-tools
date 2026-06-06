# pi-web-tools

A pi extension that adds the `web_search` and `web_fetch` tools.

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
- Does not expose `--dump original`; binary/raw downloads should be handled by a
  separate download tool.
- Always passes `--stealth` to Obscura.
- Always passes `--wait` to Obscura. The default post-navigation settle wait is
  5 seconds; set `wait` to 0 to disable it.

Parameters:

- `url`: required URL with an `http://` or `https://` scheme.
- `dump`: optional output format when `eval` is not used:
  - `markdown` (default)
  - `text`
  - `html`
  - `links`
  - `assets`: NDJSON sub-resource URLs from the rendered page.
- `eval`: optional JavaScript expression evaluated in the rendered page instead
  of dumping page content.
- `selector`: optional CSS selector to wait for before dumping output. Not valid
  with `eval`; use `document.querySelector(...)` inside `eval` instead.
- `waitUntil`: optional readiness condition: `load` (default),
  `domcontentloaded`, `networkidle0`, or `networkidle2`.
- `wait`: optional extra wait after navigation, in seconds. Defaults to 5;
  maximum 60. Set to 0 to disable the post-navigation settle wait.
- `timeout`: optional navigation timeout in seconds. Defaults to 30; valid range
  1-120.
- `proxy`: optional HTTP or SOCKS proxy URL passed to Obscura.

Output limits:

- Tool output returned to the model is truncated to pi's standard limit: 2000
  lines or 50.0KB, whichever comes first.
- If output is truncated, the full Obscura output is left in a per-user temp
  file and the path is included in the tool result.
- If the Obscura output is larger than 10 MiB, the tool reads only a small
  preview and keeps the full output file.

Usage guidance:

- Use `web_search` to find candidate URLs.
- Use `web_fetch` when the URL is already known or after selecting a search
  result.
- Use `dump=markdown` for most reading/summarization tasks.
- Use `dump=html` only when markup matters.
- Use `dump=links` for page link extraction.
- Use `dump=assets` for rendered sub-resource URLs.

## Links

- DuckDuckGo URL parameters:
  <https://duckduckgo.com/duckduckgo-help-pages/settings/params>
- Obscura headless browser: <https://github.com/h4ckf0r0day/obscura>
