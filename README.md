# Agency MCP Server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that gives MCP clients eight website-audit tools for an agency's client sites: page audits, structured-data validation, crawler access, Core Web Vitals, site crawls, answerability scoring, Search Console reporting and answer-engine visibility checks.

Every tool is scoped to one client's domain allowlist, fetches through an SSRF guard, and returns third-party text inside a fenced untrusted-data block.

- **Playground:** https://vedantkinikar.duckdns.org/demos/agency-mcp/ runs the tools against three fictional demo sites over Streamable HTTP.
- **Recorded session:** [docs/mcp-session.md](docs/mcp-session.md), also shown in the [playground](https://vedantkinikar.duckdns.org/demos/agency-mcp/session.html). The MCP SDK's client calls every tool, and every message is captured as it was sent.

Built with TypeScript, the official MCP TypeScript SDK (stdio and Streamable HTTP), Zod, Vitest and Docker.

## What is real, and what is fixture or mock

| # | Tool | Data source | Status |
|---|---|---|---|
| 1 | `audit_page` | Fetches the page | Real |
| 2 | `validate_structured_data` | The page's JSON-LD | Real |
| 3 | `check_crawler_access` | The host's `/robots.txt` and `llms.txt` | Real |
| 4 | `core_web_vitals` | Google PageSpeed Insights API v5 | Real API call. Without a key, calls share Google's anonymous daily quota, which was exhausted when this was written (HTTP 429). The tool then reports Google's error as it is. Set `PAGESPEED_API_KEY` to get a quota of your own. |
| 5 | `crawl_site` | Fetches pages and sitemaps | Real |
| 6 | `score_answerability` | Fetches the page | Real, deterministic heuristic (see below) |
| 7 | `search_console_report` | Search Console API (read-only scope) | **The live client is implemented but has never run against Google: no credentials exist.** Unit tests check the JWT signing and the request it builds against a fake endpoint. Without credentials, and always in the playground, it returns rows from [`fixtures/search-console.json`](fixtures/search-console.json). Those rows are made up, and every result says `"mode": "fixture"` with a notice. |
| 8 | `answer_engine_visibility` | A configurable chat-completions endpoint | **The HTTP provider is implemented but has never run against a real model: no key is configured.** It is tested against a fake endpoint. Without an endpoint, and always in the playground, a mock provider generates replies locally from a hash, naming the client with a fixed 35% probability. Results say `"mode": "mock"` and every mock reply starts with `[MOCK REPLY n: no language model was called]`. |

The three demo sites (a dental clinic, a coffee roaster and a plumber in Melbourne) are fictional. They come from [seo-geo-starter](https://github.com/kinikarvedant/seo-geo-starter) and run at `/demos/dental`, `/demos/cafe` and `/demos/plumber`. Their pages are `noindex`, and `audit_page` says so.

## Tools

All tools take a `client` id. Every URL must be inside that client's allowlist.

- **`audit_page`** checks one URL: title and meta description length, canonical, robots meta, `lang`, heading structure (missing or repeated h1, skipped levels, empty headings), links (internal, external, nofollow, links with no accessible name), images without `alt`, and the four required Open Graph tags. Length limits are conventions (results pages cut titles at about 60 characters), not published rules.
- **`validate_structured_data`** extracts JSON-LD (top level, `@graph` and nested) and checks LocalBusiness (and 37 common subtypes such as Dentist and Plumber), Service, FAQPage, Article (and subtypes) and BreadcrumbList for required and recommended properties. It also checks value shapes: ISO dates, absolute URLs, coordinates and crumb positions. It is a checklist based on Google's rich-result documentation, not a full schema.org vocabulary validator.
- **`check_crawler_access`** reads `/robots.txt` at the host root as RFC 9309 specifies:
  - a crawler uses its own groups, else `*`;
  - the longest match wins, and Allow wins a tie;
  - `*` and `$` are supported;
  - a 4xx means allow all, and a 5xx or network failure means disallow all.

  It reports whether GPTBot, ClaudeBot, PerplexityBot, Google-Extended and Googlebot (plus any agents you add) may fetch the URL, and which rule decides. For a site served under a path, it notes a `robots.txt` there that crawlers will never read. It then checks `llms.txt` at the root and under that path: H1 title, summary, sections and link count.
- **`core_web_vitals`** calls PageSpeed Insights. It keeps real-user field data (CrUX p75 LCP, INP and CLS for the page and the origin, when Google has enough traffic) separate from one Lighthouse lab run (score, LCP, CLS, TBT), rated against the web.dev thresholds.
- **`crawl_site`** runs a breadth-first crawl inside the allowlist. It obeys `robots.txt` for its own user-agent and is held to 2 requests per second per host (configurable). Sitemap URLs (from `robots.txt` and `<path>/sitemap.xml`, one sitemap-index level) are queued after the link crawl. It reports broken links with the pages that link to them, redirects, duplicate titles and descriptions, and **orphans**: sitemap URLs that no crawled page links to. When the page limit cuts the crawl short, it says the orphan list may be incomplete.
- **`score_answerability`** scores 0 to 100 how easily answers can be lifted from a page. It is deterministic: no model is involved.
  - *Question headings (25 points):* the share of h2-h4 and `<summary>` headings phrased as questions. Full marks at half or more.
  - *Answer first (35 points):* the share of question sections, plus the page lead after the h1, whose first sentence passes three checks. It is 50 words or fewer, it is not filler ("Welcome…", "In this article…"), and it shares a key word with the heading or opens with yes/no or a number.
  - *FAQ markup (15 points):* FAQPage JSON-LD is present. The result also counts how many of its questions are visible on the page.
  - *Paragraph length (25 points):* the share of paragraphs of 80 words or fewer.

  Each failing section gets an answer-first suggestion. It names the sentence in that section that shares the most key words with the question, preferring one short enough to lead with. The score measures structure, not whether the answers are correct.
- **`search_console_report`** returns search analytics (clicks, impressions, CTR, position) by query, page, country, device or date. The token request is signed with `node:crypto` (no Google SDK), for a service account or an OAuth refresh token, with the `webmasters.readonly` scope.
- **`answer_engine_visibility`** sends each prompt N times and counts replies that name the client (whole-word, case-insensitive brand terms).
  - Rates come with a 95% Wilson interval.
  - Given a baseline (mentions out of runs), the difference gets a Newcombe hybrid score interval. A change counts as real only when that interval excludes zero; otherwise it is run-to-run variance.
  - Only the operator's prompt is sent to the model. Page text never is.

## Safety

Each item below has tests in `test/`.

- **Read-only.** The fetcher only sends GET requests. Search Console uses the read-only scope. Every tool is annotated `readOnlyHint: true`.
- **Per-client allowlists.** `config/clients.json` maps each client to hostnames (`example.com`, or `*.example.com` for subdomains only) or URL prefixes (`https://host/demos/dental` matches that path and below, but not `/demos/dentalx`). Hostname entries allow default ports only. The allowlist is checked before the first request and again on every redirect hop. A path-scoped client may also read `/robots.txt`, `/llms.txt` and `/sitemap.xml` at its host root.
- **SSRF guard.** The address check runs inside the socket's own DNS lookup, so the address checked is the address connected to. It blocks private, loopback, link-local, CGNAT (which includes Tailscale), documentation, multicast and reserved ranges, plus IPv4-mapped and NAT64 IPv6. IP literals are checked too, and so is every redirect. Responses are capped at 2 MB, with a 15-second timeout.
- **Rate limiting.** A token bucket per host for outbound fetches (shared by all clients), one for PageSpeed and model calls, and, in the playground, 20 tool calls per visitor per 10 minutes and 300 an hour overall.
- **Secret redaction.** Configured keys, bearer tokens, `key=` query parameters, private-key blocks and JSON secret fields are scrubbed from logs and from errors returned to clients. Logs go to stderr, because stdout carries the protocol.
- **Untrusted data.** Every result's text is fenced between markers carrying a random id the page cannot guess. Every `<` inside is JSON-escaped, so a page cannot forge the closing marker. The fixture `test/fixtures/bad.html` carries a prompt-injection line and a fake marker to prove it.

## Use it

Requires Node 22 or later.

```bash
npm ci
npm run build
npm test
```

Connect an MCP client over stdio with a config like this:

```json
{
  "mcpServers": {
    "agency": {
      "command": "node",
      "args": ["/path/to/agency-mcp-server/dist/stdio.js"],
      "env": { "CLIENTS_FILE": "/path/to/clients.json", "PAGESPEED_API_KEY": "..." }
    }
  }
}
```

Run the Streamable HTTP server and the playground with `npm run start:http` (port 3000, `POST /mcp`), or with Docker:

```bash
docker build -t agency-mcp-server .
docker run --rm -p 3000:3000 -e DEMO_MODE=1 agency-mcp-server
```

| Variable | Purpose |
|---|---|
| `CLIENTS_FILE` | Client allowlists (default `config/clients.json`, the three demo sites) |
| `PAGESPEED_API_KEY` | Optional PageSpeed Insights key |
| `GSC_SERVICE_ACCOUNT_JSON` | Service-account key, as a file path or inline JSON |
| `GSC_OAUTH_CLIENT_ID`, `GSC_OAUTH_CLIENT_SECRET`, `GSC_OAUTH_REFRESH_TOKEN` | Or an OAuth client with a refresh token |
| `MODEL_API_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME` | Any endpoint that accepts `POST {base}/chat/completions` |
| `DEMO_MODE=1` | Search Console and visibility always use fixture and mock data |
| `FETCH_RATE_PER_SECOND`, `MAX_CRAWL_PAGES` | Outbound politeness: default 2 per second, 200 pages |
| `PORT`, `BASE_PATH` | HTTP server port and path prefix |

`npm run record` rebuilds and re-records the MCP session against the live demo sites.

## Tests

88 Vitest tests, run in CI on Node 22 and 24, followed by a Docker build that boots the image and lists the tools over HTTP. They use local fixture servers and fake API responses, so no network is needed. They cover:

- each tool's findings;
- the allowlist and SSRF cases: private DNS answers, redirects into metadata and private addresses, redirects out of the allowlist, loops, size caps;
- rate limiting and redaction;
- the untrusted fence;
- the MCP server over an in-memory transport;
- the HTTP endpoint's per-visitor limit;
- the published Wilson and Newcombe values.

## Limits

- The robots.txt matcher does not normalise percent-encoding, and does not fall back from sub-agents (Googlebot-News) to their parent token.
- The crawl is sequential and follows one sitemap-index level. Links outside the allowlist are counted, not checked.
- Answerability uses a 4-letter prefix as a stemmer and simple sentence splitting.
- The structured-data checks cover five types and their common subtypes, not the whole vocabulary.

## License

MIT
