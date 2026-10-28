import { describe, expect, it } from "vitest";
import { crawlSite } from "../src/tools/crawl.js";
import { fixtureSite, siteCtx } from "./helpers.js";

const page = (title: string, links: string[], description = `About ${title}`) => ({
  body: `<html><head><title>${title}</title><meta name="description" content="${description}"></head><body>${links.map((l) => `<a href="${l}">${l}</a>`).join(" ")}</body></html>`,
});

describe("crawl_site", async () => {
  const site = await fixtureSite({
    "/robots.txt": (o) => ({ type: "text/plain", body: `User-agent: *\nDisallow: /private\nSitemap: ${o}/sitemap-index.xml\n` }),
    "/sitemap-index.xml": (o) => ({ type: "application/xml", body: `<sitemapindex><sitemap><loc>${o}/sitemap-pages.xml</loc></sitemap><sitemap><loc>https://elsewhere.test/sitemap.xml</loc></sitemap></sitemapindex>` }),
    "/sitemap-pages.xml": (o) => ({ type: "application/xml", body: `<urlset><url><loc>${o}/</loc></url><url><loc>${o}/a</loc></url><url><loc>${o}/c</loc></url><url><loc>https://elsewhere.test/x</loc></url></urlset>` }),
    "/": page("Home", ["/a", "/b", "/broken", "/redirect", "/private/x", "https://example.org/", "mailto:a@example.com", "#top"]),
    "/a": page("Same title", ["/", "/b"], "Same description"),
    "/b": page("Same title", ["/"], "Same description"),
    "/c": page("Only in the sitemap", ["/gone"]),
    "/redirect": { status: 301, location: "/a" },
  });
  const ctx = siteCtx(site.origin);

  it("reports broken links, redirects, duplicates and orphans", async () => {
    const r = await crawlSite(ctx, { url: `${site.origin}/` });
    const o = site.origin;
    expect(r.complete).toBe(true);
    expect(r.broken).toEqual([
      { url: `${o}/broken`, status: 404, linkedFrom: [`${o}/`], inSitemap: false },
      { url: `${o}/gone`, status: 404, linkedFrom: [`${o}/c`], inSitemap: false },
    ]);
    expect(r.redirects).toEqual([{ from: `${o}/redirect`, to: `${o}/a`, status: 301 }]);
    expect(r.duplicateTitles).toEqual([{ text: "Same title", urls: [`${o}/a`, `${o}/b`] }]);
    expect(r.duplicateDescriptions).toEqual([{ text: "Same description", urls: [`${o}/a`, `${o}/b`] }]);
    expect(r.orphans).toEqual([`${o}/c`]);
    expect(r.robots.blockedForThisCrawler).toEqual([`${o}/private/x`]);
    expect(r.externalLinksSkipped).toBe(1);
    expect(r.sitemap.files.map((f) => [f.url.replace(o, ""), f.status, f.inScope])).toEqual([
      ["/sitemap-index.xml", 200, 0], ["/sitemap.xml", 404, 0], ["/sitemap-pages.xml", 200, 3],
    ]);
    // Out-of-allowlist links and sitemap entries are never fetched; robots-blocked pages are not either.
    expect(site.hits).not.toContain("/private/x");
    expect(site.hits.filter((h) => h === "/b")).toHaveLength(1); // linked three times, fetched once
  });

  it("stops at maxPages and says the orphan list may be incomplete", async () => {
    const r = await crawlSite(ctx, { url: `${site.origin}/`, maxPages: 2 });
    expect(r.pagesFetched).toBe(2);
    expect(r.complete).toBe(false);
    expect(r.notes.join(" ")).toMatch(/Stopped at 2 pages/);
  });

  it("caps maxPages at the server limit", async () => {
    const r = await crawlSite(siteCtx(site.origin, { MAX_CRAWL_PAGES: "3" }), { url: `${site.origin}/`, maxPages: 400 });
    expect(r.limits.maxPages).toBe(3);
    expect(r.pagesFetched).toBe(3);
  });
});
