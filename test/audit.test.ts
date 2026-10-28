import { describe, expect, it } from "vitest";
import { auditPage } from "../src/tools/audit.js";
import { fixture, fixtureSite, siteCtx } from "./helpers.js";

describe("audit_page", async () => {
  const site = await fixtureSite({
    "/": { body: fixture("good.html") },
    "/bad": { body: fixture("bad.html") },
    "/moved": { location: "/" },
    "/data.json": { type: "application/json", body: "{}" },
  });
  const ctx = siteCtx(site.origin);

  it("passes a complete page", async () => {
    const r = await auditPage(ctx, `${site.origin}/`);
    expect(r.issues.filter((i) => i.severity !== "info")).toEqual([]);
    expect(r.title.text).toBe("Test Dental | Family dentist in Testville");
    expect(r.canonical).toBe(`${site.origin}/`);
    expect(r.lang).toBe("en-AU");
    expect(r.links).toMatchObject({ internal: 5, external: 1, nofollow: 1, withoutText: [] });
    expect(r.images).toMatchObject({ total: 2, missingAlt: [], decorative: 1 });
    expect(r.openGraph["og:type"]).toBe("website");
  });

  it("flags every problem on a broken page", async () => {
    const r = await auditPage(ctx, `${site.origin}/bad`);
    const checks = r.issues.map((i) => `${i.severity}:${i.check}`);
    expect(checks).toEqual(expect.arrayContaining([
      "error:title", "warning:meta-description", "info:canonical", "warning:robots-meta", "warning:lang",
      "warning:headings", "warning:links", "error:images", "warning:open-graph",
    ]));
    expect(r.issues.some((i) => /2 <h1>/.test(i.message))).toBe(true);
    expect(r.issues.some((i) => /skips from h1 to h4/.test(i.message))).toBe(true);
    expect(r.issues.some((i) => /Empty h2/.test(i.message))).toBe(true);
    expect(r.images.missingAlt).toEqual(["/icon.png", "/no-alt.jpg"]);
    expect(r.links.withoutText).toEqual([`${site.origin}/empty`, `${site.origin}/icon`]);
  });

  it("follows redirects and reports them", async () => {
    const r = await auditPage(ctx, `${site.origin}/moved`);
    expect(r.url).toBe(`${site.origin}/`);
    expect(r.redirects).toEqual([{ from: `${site.origin}/moved`, to: `${site.origin}/`, status: 302 }]);
  });

  it("rejects non-HTML, 404s and URLs outside the allowlist", async () => {
    await expect(auditPage(ctx, `${site.origin}/data.json`)).rejects.toThrow(/not an HTML page/);
    await expect(auditPage(ctx, `${site.origin}/missing`)).rejects.toThrow(/HTTP 404/);
    await expect(auditPage(ctx, "https://example.com/")).rejects.toThrow(/outside this client's allowlist/);
    expect(site.hits).not.toContain("https://example.com/");
  });
});
