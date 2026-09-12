pi-web-tools
============

Adds two tools to the [pi] coding agent:

 -  `web_search`, which searches DuckDuckGo, and
 -  `web_fetch`, which fetches pages.

Both tools use the excellent [Obscura headless browser]. The `obscura` CLI must
be installed and available on `PATH`.

[pi]: https://github.com/earendil-works/pi
[Obscura headless browser]: https://github.com/h4ckf0r0day/obscura


Tools
-----

### web\_search

Opens DuckDuckGo's HTML search (`https://html.duckduckgo.com/html/?q=example`)
through Obscura and returns result titles, URLs, and snippets.

The tool uses JavaScript evaluation to read the
final page URL, detect known DuckDuckGo challenge elements, and extract at most
20 results.

Parameters:

 -  `query`: search query, 1–500 characters.
 -  `limit`: optional number of results to return, 1–20. Defaults to 10.

Use `web_search` for discovery. Its summary includes output size, result count,
elapsed time, and cache status. Concurrent searches are serialized (to avoid
DuckDuckGo anti-bot detection), and queued searches start at least one second
apart. A detected anti-bot challenge fails the search. A failed search is not
retried, and the tool does not fall back to a Node.js or another backend.

### web\_fetch

Fetches a specific URL with the
[`obscura`] CLI.

Behavior:

 -  Defaults to `--dump markdown`, which keeps headings, lists, and links while
    avoiding most HTML noise.
 -  Uses `--quiet` and `--output` so the tool controls output size consistently.
 -  Supports JavaScript-rendered pages through Obscura. Use `eval` to inspect
    rendered page content.
 -  The extension's private-network preflight protection remains enabled by
    default; however, Obscura's own protection is disabled by `--stealth`.
 -  Rejects localhost/special-use hostnames, private or reserved IP literals,
    and hostnames that resolve to private or reserved IP addresses before
    invoking Obscura.
 -  Rejects URLs containing userinfo credentials, query parameters, or fragment
    values that look like credentials or tokens.
 -  Does not expose `--dump original`; binary/raw downloads should be handled
    by a separate download tool.
 -  Always passes `--stealth` to Obscura.
 -  Always passes `--wait` to Obscura. The default post-navigation wait is 5
    seconds; set `wait` to 0 to disable it.
 -  Its compact summary includes the output mode, dumped output size, elapsed
    time, and truncation status. Obscura's current CLI output does not expose
    the page's HTTP status.

Parameters:

 -  `url`: required public URL with an `http://` or `https://` scheme. Local or
    private-network hosts, userinfo credentials, and sensitive query parameters
    or fragment values are rejected.
 -  `dump`: optional output format when `eval` is not used:
     -  `markdown` (default)
     -  `text`
     -  `html`
     -  `links`
     -  `assets`: subresource URLs from the rendered page in NDJSON format.
 -  `eval`: optional JavaScript expression evaluated in the rendered page
    instead of dumping page content.
 -  `selector`: optional CSS selector to wait for before dumping output. Not
    valid with `eval`; use `document.querySelector(...)` inside `eval` instead.
 -  `waitUntil`: optional readiness condition: `load` (default),
    `domcontentloaded`, `networkidle0`, or `networkidle2`.
 -  `wait`: optional extra wait after navigation, in seconds. Defaults to 5; the
    valid range is 0–60. Set to 0 to disable the post-navigation wait.
 -  `timeout`: optional navigation timeout in seconds. Defaults to 30; the valid
    range is 1–120.
 -  `proxy`: optional HTTP or SOCKS proxy URL passed to Obscura.

Output limits:

 -  Page content and Obscura diagnostics returned to the model are limited
    together to pi's standard limit: 2000 lines or 50.0 KB, whichever comes
    first.
 -  If page content is truncated, the full page output is left in a per-user
    temporary file and the path is included in the tool result. Truncated
    diagnostics are not retained.
 -  Obscura page output is scanned from disk using constant memory; only the
    bounded preview returned to the model is retained in memory.

[`obscura`]: https://github.com/h4ckf0r0day/obscura


Usage guidance
--------------

 -  Use `web_search` to find candidate URLs.
 -  Use `web_fetch` when the URL is already known or after selecting a search
    result.
 -  Use `dump=markdown` for most reading or summarization tasks.
 -  Use `dump=html` only when markup matters.
 -  Use `dump=links` for page link extraction.
 -  Use `dump=assets` for rendered subresource URLs.


Known issues
------------

This extension uses Obscura in `--stealth` mode, which disables checks for
private and internal addresses. Access to those addresses can be used for
exfiltration.

 -  Host checks are a preflight step only; redirects or later DNS changes can
    still cause Obscura to connect to a different address. Redirect targets
    should be checked separately.
 -  Reserved-name and IP-range coverage is not exhaustive; some special-use
    hostnames and reserved addresses may not be rejected. Complete coverage is
    difficult to guarantee.
 -  Sensitive URL detection is heuristic. Query and fragment data is inspected
    through at most two URL-form decoding passes; token-like values hidden more
    deeply inside nested URLs may be missed. Complete detection is difficult to
    guarantee.

Run pi in `sandbox-exec(1)` with Little Snitch, or otherwise isolate it from
private data and infrastructure, to reduce the risk of exfiltration attacks.


Links
-----

 -  DuckDuckGo URL parameters:
    <https://duckduckgo.com/duckduckgo-help-pages/settings/params>
 -  Obscura headless browser: <https://github.com/h4ckf0r0day/obscura>
