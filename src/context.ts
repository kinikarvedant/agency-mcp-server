import type dns from "node:dns";
import { parse, type HTMLElement } from "node-html-parser";
import type { Client, Config, Env } from "./config.js";
import { safeGet, type Page } from "./net.js";
import { RateLimiter, Refusal, registerSecret } from "./safety.js";

/** Everything a tool may touch: one client's allowlisted GET, and fixed third-party APIs. */
export interface Ctx {
  client: Client;
  env: Env;
  /** SSRF-guarded, allowlisted, rate-limited GET. `siteFile` also allows /robots.txt etc. at the host root. */
  get(url: string | URL, opts?: { siteFile?: boolean }): Promise<Page>;
  /** For the fixed Google and model endpoints, which take no user-supplied hosts. */
  api: typeof fetch;
  limiter: RateLimiter;
}

export interface Deps {
  api?: typeof fetch;
  lookup?: typeof dns.lookup;
  trusted?: string[];
  limiter?: RateLimiter;
}

const shared = new Map<number, RateLimiter>();

export function makeCtx(config: Config, clientId: string, deps: Deps = {}): Ctx {
  const client = config.clients.get(clientId);
  if (!client) throw new Refusal(`unknown client "${clientId}"; configured: ${[...config.clients.keys()].join(", ")}`);
  const e = config.env;
  for (const secret of [e.PAGESPEED_API_KEY, e.GSC_OAUTH_CLIENT_SECRET, e.GSC_OAUTH_REFRESH_TOKEN, e.MODEL_API_KEY]) registerSecret(secret);
  const rate = e.FETCH_RATE_PER_SECOND;
  // One limiter per process, shared by every client, so two clients on one host share its budget.
  const limiter = deps.limiter ?? shared.get(rate) ?? shared.set(rate, new RateLimiter(Math.ceil(rate), rate)).get(rate)!;
  return {
    client,
    env: config.env,
    api: deps.api ?? fetch,
    limiter,
    get: (url, opts) =>
      safeGet(url, {
        check: (u) => client.allowlist.check(u, opts),
        limiter,
        lookup: deps.lookup,
        trusted: deps.trusted,
      }),
  };
}

// ------------------------------------------------------------------ HTML helpers

export function parseHtml(html: string): HTMLElement {
  return parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true, pre: true } });
}

export const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
export const wordCount = (s: string) => clean(s).split(" ").filter(Boolean).length;

/** <meta name=...> or <meta property=...>, case-insensitive. */
export function meta(doc: HTMLElement, key: string): string | undefined {
  const el = doc.querySelectorAll("meta").find((m) => (m.getAttribute("name") ?? m.getAttribute("property"))?.toLowerCase() === key);
  return el ? clean(el.getAttribute("content")) : undefined;
}

export function jsonLd(doc: HTMLElement): { data?: unknown; error?: string }[] {
  return doc
    .querySelectorAll("script")
    .filter((s) => s.getAttribute("type")?.toLowerCase().trim() === "application/ld+json")
    .map((s) => {
      try {
        return { data: JSON.parse(s.rawText) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    });
}

/** Fetches an allowlisted URL and parses it, or throws if it is not a reachable HTML page. */
export async function getHtml(ctx: Ctx, url: string) {
  const page = await ctx.get(url);
  if (page.status >= 400) throw new Error(`${page.url} returned HTTP ${page.status}`);
  const type = page.headers["content-type"] ?? "";
  if (!/html/i.test(type)) throw new Error(`${page.url} is not an HTML page (content-type "${type}")`);
  return { page, doc: parseHtml(page.body) };
}
