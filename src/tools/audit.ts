import { clean, getHtml, meta, type Ctx } from "../context.js";

export interface Issue {
  severity: "error" | "warning" | "info";
  check: string;
  message: string;
}

const LIST_CAP = 20;

/**
 * On-page basics. Length limits are common conventions (results pages cut titles by pixel
 * width, roughly 60 characters), not rules any search engine publishes.
 */
export async function auditPage(ctx: Ctx, url: string) {
  const { page, doc } = await getHtml(ctx, url);
  const issues: Issue[] = [];
  const add = (severity: Issue["severity"], check: string, message: string) => issues.push({ severity, check, message });
  const base = new URL(page.url);

  const title = clean(doc.querySelector("title")?.text);
  if (!title) add("error", "title", "No <title>.");
  else if (title.length > 60) add("warning", "title", `Title is ${title.length} characters; results pages usually cut it near 60.`);
  else if (title.length < 15) add("warning", "title", `Title is only ${title.length} characters.`);

  const description = meta(doc, "description");
  if (!description) add("warning", "meta-description", "No meta description, so search engines pick a snippet themselves.");
  else if (description.length > 160) add("info", "meta-description", `Meta description is ${description.length} characters; it is usually cut near 160.`);
  else if (description.length < 50) add("info", "meta-description", `Meta description is only ${description.length} characters.`);

  const canonicalHref = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const canonical = canonicalHref ? new URL(canonicalHref, base).href : undefined;
  if (!canonical) add("info", "canonical", "No canonical link.");
  const robots = meta(doc, "robots");
  if (robots && /noindex/i.test(robots)) add("warning", "robots-meta", `Robots meta says "${robots}"; this page asks not to be indexed.`);
  const lang = doc.querySelector("html")?.getAttribute("lang");
  if (!lang) add("warning", "lang", "No lang attribute on <html>.");

  const headings = doc.querySelectorAll("h1, h2, h3, h4, h5, h6").map((h) => ({ level: Number(h.tagName[1]), text: clean(h.text) }));
  const h1s = headings.filter((h) => h.level === 1).length;
  if (h1s === 0) add("error", "headings", "No <h1>.");
  if (h1s > 1) add("warning", "headings", `${h1s} <h1> elements; one is the usual pattern.`);
  headings.forEach((h, i) => {
    const prev = headings[i - 1];
    if (prev && h.level > prev.level + 1) add("warning", "headings", `Heading level skips from h${prev.level} to h${h.level} at "${h.text}".`);
    if (!h.text) add("warning", "headings", `Empty h${h.level}.`);
  });

  let internal = 0, external = 0, nofollow = 0;
  const emptyAnchors: string[] = [];
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href")!.trim();
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    let target: URL;
    try { target = new URL(href, base); } catch { continue; }
    if (target.host === base.host) internal++;
    else external++;
    if (/nofollow/i.test(a.getAttribute("rel") ?? "")) nofollow++;
    const name = clean(a.text) || a.getAttribute("aria-label") || a.getAttribute("title") || a.querySelector("img")?.getAttribute("alt");
    if (!clean(name ?? "")) emptyAnchors.push(target.href);
  }
  if (emptyAnchors.length) add("warning", "links", `${emptyAnchors.length} link(s) have no text or accessible name.`);

  const imgs = doc.querySelectorAll("img");
  const missingAlt = imgs.filter((i) => !i.hasAttribute("alt")).map((i) => i.getAttribute("src") ?? "(no src)");
  const decorative = imgs.filter((i) => i.getAttribute("alt") === "").length;
  if (missingAlt.length) add("error", "images", `${missingAlt.length} of ${imgs.length} image(s) have no alt attribute.`);

  const og: Record<string, string | null> = Object.fromEntries(["og:title", "og:description", "og:image", "og:url", "og:type", "twitter:card"].map((k) => [k, meta(doc, k) ?? null]));
  const missingOg = ["og:title", "og:type", "og:image", "og:url"].filter((k) => !og[k]);
  if (missingOg.length) add("warning", "open-graph", `Missing ${missingOg.join(", ")} (required by the Open Graph protocol).`);

  return {
    url: page.url,
    status: page.status,
    redirects: page.redirects,
    title: { text: title, length: title.length },
    metaDescription: description ? { text: description, length: description.length } : null,
    canonical: canonical ?? null,
    robots: robots ?? null,
    lang: lang ?? null,
    headings: headings.slice(0, 40),
    links: { internal, external, nofollow, withoutText: emptyAnchors.slice(0, LIST_CAP) },
    images: { total: imgs.length, missingAlt: missingAlt.slice(0, LIST_CAP), decorative },
    openGraph: og,
    summary: { errors: issues.filter((i) => i.severity === "error").length, warnings: issues.filter((i) => i.severity === "warning").length },
    issues,
  };
}
