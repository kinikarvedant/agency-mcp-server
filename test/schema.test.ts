import { describe, expect, it } from "vitest";
import { parseHtml, jsonLd } from "../src/context.js";
import { validateJsonLd, validateStructuredData } from "../src/tools/schema.js";
import { fixture, fixtureSite, siteCtx } from "./helpers.js";

const fromHtml = (name: string) => validateJsonLd(jsonLd(parseHtml(fixture(name))));

describe("validate_structured_data", () => {
  it("accepts complete LocalBusiness, FAQPage, BreadcrumbList and Service items", () => {
    const r = fromHtml("good.html");
    expect(r.items.map((i) => [i.type, i.checkedAs])).toEqual([
      ["Dentist", "LocalBusiness"], ["FAQPage", "FAQPage"], ["BreadcrumbList", "BreadcrumbList"], ["Service", "Service"],
    ]);
    expect(r.summary).toEqual({ items: 4, errors: 0, warnings: 0 });
  });

  it("reports parse errors, missing properties and bad values", () => {
    const r = fromHtml("bad.html");
    expect(r.parseErrors).toHaveLength(1);
    const by = (t: string) => r.items.find((i) => i.checkedAs === t)!;
    expect(by("FAQPage").errors).toEqual(["Question 1 has no acceptedAnswer.", "mainEntity[1] is not a Question."]);
    expect(by("Article").errors).toEqual(["datePublished is not an ISO 8601 date."]);
    expect(by("Article").warnings).toEqual(expect.arrayContaining(["Missing image (recommended).", "author should be a Person or Organization with a name."]));
    expect(by("BreadcrumbList").warnings).toEqual(expect.arrayContaining([
      "Crumb 1 has position 2; positions should run 1, 2, 3 in order.", "Crumb 2's item is not an absolute URL.",
    ]));
    expect(by("BreadcrumbList").errors).toEqual(["Crumb 1 has no item URL (only the last crumb may leave it out)."]);
    expect(by("LocalBusiness").errors).toEqual(['No "@context": "https://schema.org".', "geo latitude/longitude are not valid coordinates."]);
    expect(by("LocalBusiness").warnings).toContain("address is plain text; a PostalAddress lets parsers read street, suburb and postcode.");
    expect(by("Service").errors).toEqual(["Missing name or serviceType."]);
    expect(r.uncheckedTypes).toEqual(["Event"]);
  });

  it("checks Article dates and required headline", () => {
    const r = validateJsonLd([{ data: { "@context": "https://schema.org", "@type": "NewsArticle", datePublished: "2026-10-01T09:00:00+11:00", author: { "@type": "Person", name: "A" } } }]);
    expect(r.items[0].errors).toEqual(["Missing headline."]);
  });

  it("skips bare references and validates nested typed entities", () => {
    const r = validateJsonLd([{ data: { "@context": "https://schema.org", "@type": "WebPage", mainEntity: { "@type": "FAQPage", mainEntity: [] }, about: { "@id": "#biz", "@type": "Dentist" } } }]);
    expect(r.items).toEqual([expect.objectContaining({ checkedAs: "FAQPage", errors: ["mainEntity has no Question items."] })]);
    expect(r.uncheckedTypes).toEqual(["WebPage"]);
  });

  it("fetches the page through the allowlisted context", async () => {
    const site = await fixtureSite({ "/": { body: fixture("good.html") } });
    const r = await validateStructuredData(siteCtx(site.origin), `${site.origin}/`);
    expect(r.summary.items).toBe(4);
  });
});
