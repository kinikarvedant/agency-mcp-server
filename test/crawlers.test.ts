import { describe, expect, it } from "vitest";
import { checkCrawlerAccess, evaluate, parseRobots } from "../src/tools/crawlers.js";
import { fixtureSite, siteCtx } from "./helpers.js";

const ROBOTS = `
# comment
User-agent: GPTBot
User-agent: PerplexityBot
Disallow: /

User-agent: Googlebot
Disallow: /private/
Allow: /private/press/
Disallow: /*.pdf$

User-agent: *
Disallow: /admin
Allow: /admin/public
Disallow: /tmp/  # trailing comment

Sitemap: https://site.test/sitemap.xml
`;

describe("robots.txt rules", () => {
  const robots = parseRobots(ROBOTS);

  it("groups consecutive user-agent lines and collects sitemaps", () => {
    expect(robots.groups.map((g) => g.agents)).toEqual([["gptbot", "perplexitybot"], ["googlebot"], ["*"]]);
    expect(robots.sitemaps).toEqual(["https://site.test/sitemap.xml"]);
  });

  it("uses the agent's own group, falling back to *", () => {
    expect(evaluate(robots, "GPTBot", "/")).toEqual({ allowed: false, group: "GPTBot", rule: "Disallow: /" });
    expect(evaluate(robots, "perplexitybot", "/x").allowed).toBe(false);
    expect(evaluate(robots, "ClaudeBot", "/")).toEqual({ allowed: true, group: "*", rule: null });
    expect(evaluate(robots, "ClaudeBot", "/admin/x").allowed).toBe(false);
    // Googlebot has its own group, so the * rules do not apply to it.
    expect(evaluate(robots, "Googlebot", "/admin").allowed).toBe(true);
  });

  it("lets the longest match win and Allow win ties", () => {
    expect(evaluate(robots, "Googlebot", "/private/a").allowed).toBe(false);
    expect(evaluate(robots, "Googlebot", "/private/press/a")).toMatchObject({ allowed: true, rule: "Allow: /private/press/" });
    expect(evaluate(robots, "Google-Extended", "/admin/public/x")).toMatchObject({ allowed: true, rule: "Allow: /admin/public" });
    const tie = parseRobots("User-agent: *\nDisallow: /page\nAllow: /page");
    expect(evaluate(tie, "x", "/page").allowed).toBe(true);
  });

  it("supports * wildcards and $ anchors", () => {
    expect(evaluate(robots, "Googlebot", "/files/report.pdf").allowed).toBe(false);
    expect(evaluate(robots, "Googlebot", "/files/report.pdf?x=1").allowed).toBe(true);
  });

  it("treats an empty Disallow as allow-all and robots.txt itself as always allowed", () => {
    const r = parseRobots("User-agent: *\nDisallow:\n");
    expect(evaluate(r, "GPTBot", "/anything").allowed).toBe(true);
    expect(evaluate(parseRobots("User-agent: *\nDisallow: /"), "GPTBot", "/robots.txt").allowed).toBe(true);
  });
});

describe("check_crawler_access", () => {
  it("reads the root robots.txt, notes a subpath one, and inspects llms.txt", async () => {
    const site = await fixtureSite({
      "/robots.txt": { type: "text/plain", body: "User-agent: GPTBot\nDisallow: /shop\n\nUser-agent: *\nAllow: /\n" },
      "/shop/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /" },
      "/shop/llms.txt": { type: "text/plain", body: "# Test Shop\n\n> A shop.\n\n## Pages\n\n- [Home](https://site.test/shop)\n- [About](https://site.test/shop/about)\n" },
      "/llms.txt": { body: "<!doctype html><p>soft 404</p>" },
    });
    const ctx = siteCtx(`${site.origin}/shop`);
    const r = await checkCrawlerAccess(ctx, { url: `${site.origin}/shop/item`, agents: ["Bingbot"] });
    expect(r.robots.state).toBe("found");
    expect(r.subpathRobots?.note).toMatch(/only read \/robots.txt at the host root/);
    expect(Object.fromEntries(r.agents.map((a) => [a.agent, a.allowed]))).toEqual({
      GPTBot: false, ClaudeBot: true, PerplexityBot: true, "Google-Extended": true, Googlebot: true, Bingbot: true,
    });
    expect(r.llmsTxt).toEqual([
      { url: `${site.origin}/llms.txt`, status: 200, found: false, problem: "Served HTML, not markdown." },
      { url: `${site.origin}/shop/llms.txt`, status: 200, found: true, bytes: expect.any(Number), title: "Test Shop", hasSummary: true, sections: 1, links: 2 },
    ]);
  });

  it("follows RFC 9309 when robots.txt is missing (allow all) or failing (disallow all)", async () => {
    const missing = await fixtureSite({});
    const r1 = await checkCrawlerAccess(siteCtx(missing.origin), { url: `${missing.origin}/` });
    expect(r1.robots.state).toBe("missing");
    expect(r1.agents.every((a) => a.allowed)).toBe(true);

    const failing = await fixtureSite({ "/robots.txt": { status: 503, body: "down" } });
    const r2 = await checkCrawlerAccess(siteCtx(failing.origin), { url: `${failing.origin}/` });
    expect(r2.robots.state).toBe("unreachable");
    expect(r2.agents.every((a) => !a.allowed)).toBe(true);
  });

  it("refuses a URL outside the allowlist before fetching anything", async () => {
    const site = await fixtureSite({});
    await expect(checkCrawlerAccess(siteCtx(`${site.origin}/shop`), { url: `${site.origin}/other` })).rejects.toThrow(/outside/);
    expect(site.hits).toEqual([]);
  });
});
