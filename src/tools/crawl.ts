import { clean, meta, parseHtml, type Ctx } from "../context.js";
import { evaluate, loadRobots } from "./crawlers.js";

interface PageInfo { status: number; finalUrl?: string; redirectStatus?: number; error?: string; title?: string; description?: string; html?: boolean }

const decodeXml = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** Reads sitemap files, following one sitemap index level. Only URLs inside the allowlist are kept. */
async function readSitemaps(ctx: Ctx, urls: string[]) {
  const locs = new Set<string>();
  const files: { url: string; status: number; urls: number; inScope: number; error?: string }[] = [];
  const todo = [...new Set(urls)];
  while (todo.length && files.length < 10) {
    const url = todo.shift()!;
    try {
      const p = await ctx.get(url, { siteFile: true });
      const found = p.status === 200 ? [...p.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeXml(m[1])) : [];
      if (/<sitemapindex/i.test(p.body)) {
        todo.push(...found.filter((f) => ctx.client.allowlist.match(new URL(f), { siteFile: true }) !== null));
        files.push({ url, status: p.status, urls: found.length, inScope: 0 });
        continue;
      }
      const inScope = found.filter((f) => URL.canParse(f) && ctx.client.allowlist.match(new URL(f)) !== null);
      inScope.forEach((f) => locs.add(new URL(f).href));
      files.push({ url, status: p.status, urls: found.length, inScope: inScope.length });
    } catch (e) {
      files.push({ url, status: 0, urls: 0, inScope: 0, error: (e as Error).message });
    }
  }
  return { locs, files };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function duplicates(pages: [string, PageInfo][], key: "title" | "description") {
  const groups = new Map<string, { text: string; urls: string[] }>();
  for (const [url, p] of pages) {
    const text = p[key];
    if (!text) continue;
    const g = groups.get(norm(text)) ?? { text, urls: [] };
    g.urls.push(url);
    groups.set(norm(text), g);
  }
  return [...groups.values()].filter((g) => g.urls.length > 1);
}

/**
 * Breadth-first crawl inside the client's allowlist, obeying robots.txt for this crawler and the
 * per-host rate limit. Sitemap URLs are queued after the link crawl, so they get a status too.
 */
export async function crawlSite(ctx: Ctx, input: { url: string; maxPages?: number }) {
  const start = new URL(input.url);
  start.hash = "";
  ctx.client.allowlist.check(start);
  const maxPages = Math.min(input.maxPages ?? 50, ctx.env.MAX_CRAWL_PAGES);
  const base = ctx.client.allowlist.match(start) ?? "";
  const robots = await loadRobots(ctx, start);

  const pages = new Map<string, PageInfo>();
  const linksTo = new Map<string, Set<string>>();
  const queued = new Set<string>();
  const queue: string[] = [];
  const robotsBlocked: string[] = [];
  let externalLinks = 0;
  const enqueue = (href: string) => { if (!queued.has(href)) { queued.add(href); queue.push(href); } };

  const visit = async (href: string) => {
    const u = new URL(href);
    if (!evaluate(robots.robots, "AgencyAuditBot", u.pathname + u.search).allowed) return void robotsBlocked.push(href);
    let page;
    try {
      page = await ctx.get(href);
    } catch (e) {
      // A refusal here is a redirect leaving the allowlist or into a private address.
      return void pages.set(href, { status: 0, error: (e as Error).message });
    }
    const html = /html/i.test(page.headers["content-type"] ?? "");
    const info: PageInfo = { status: page.status, html, ...(page.url !== href ? { finalUrl: page.url, redirectStatus: page.redirects[0]?.status } : {}) };
    pages.set(href, info);
    if (page.status >= 400 || !html) return;
    const doc = parseHtml(page.body);
    info.title = clean(doc.querySelector("title")?.text) || undefined;
    info.description = meta(doc, "description") || undefined;
    for (const a of doc.querySelectorAll("a[href]")) {
      let target: URL;
      try { target = new URL(a.getAttribute("href")!.trim(), page.url); } catch { continue; }
      if (target.protocol !== "http:" && target.protocol !== "https:") continue;
      target.hash = "";
      if (ctx.client.allowlist.match(target) === null) { externalLinks++; continue; }
      (linksTo.get(target.href) ?? linksTo.set(target.href, new Set()).get(target.href)!).add(page.url);
      enqueue(target.href);
    }
  };

  const run = async () => { while (queue.length && pages.size < maxPages) await visit(queue.shift()!); };
  enqueue(start.href);
  await run();
  const sitemapCandidates = [...robots.robots.sitemaps.filter((s) => URL.canParse(s)), new URL(`${base}/sitemap.xml`, start.origin).href];
  const sitemap = await readSitemaps(ctx, sitemapCandidates.filter((s) => ctx.client.allowlist.match(new URL(s), { siteFile: true }) !== null));
  sitemap.locs.forEach(enqueue);
  await run();

  const linked = new Set<string>();
  for (const t of linksTo.keys()) { linked.add(t); const f = pages.get(t)?.finalUrl; if (f) linked.add(f); }
  const startFinal = pages.get(start.href)?.finalUrl;
  const orphans = [...sitemap.locs].filter((l) => l !== start.href && l !== startFinal && !linked.has(l) && !linked.has(pages.get(l)?.finalUrl ?? ""));

  const entries = [...pages.entries()];
  const okPages = [...new Map(entries.filter(([, p]) => p.status === 200 && p.html).map(([u, p]) => [p.finalUrl ?? u, p])).entries()];
  const complete = queue.length === 0;

  return {
    start: start.href,
    pagesFetched: pages.size,
    complete,
    limits: { maxPages, requestsPerSecondPerHost: ctx.env.FETCH_RATE_PER_SECOND },
    robots: { url: robots.url, state: robots.state, blockedForThisCrawler: robotsBlocked.slice(0, 20) },
    broken: entries
      .filter(([, p]) => p.status >= 400 || p.status === 0)
      .map(([url, p]) => ({ url, status: p.status || null, error: p.error, linkedFrom: [...(linksTo.get(url) ?? [])].slice(0, 5), inSitemap: sitemap.locs.has(url) })),
    redirects: entries.filter(([, p]) => p.finalUrl).map(([url, p]) => ({ from: url, to: p.finalUrl!, status: p.redirectStatus })).slice(0, 20),
    duplicateTitles: duplicates(okPages, "title"),
    duplicateDescriptions: duplicates(okPages, "description"),
    missingTitles: okPages.filter(([, p]) => !p.title).map(([u]) => u).slice(0, 20),
    missingDescriptions: okPages.filter(([, p]) => !p.description).map(([u]) => u).slice(0, 20),
    sitemap: { files: sitemap.files, urlsInScope: sitemap.locs.size },
    orphans,
    externalLinksSkipped: externalLinks,
    notes: [
      "Orphans are sitemap URLs that no crawled page links to (the start page is exempt).",
      ...(complete ? [] : [`Stopped at ${maxPages} pages before the queue emptied, so orphans may include pages the crawl had not reached yet.`]),
      "Links outside the client's allowlist are counted but never fetched.",
    ],
  };
}
