import type { Ctx } from "../context.js";
import { redact } from "../safety.js";

const PSI = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

// web.dev thresholds: [good up to, poor above].
const THRESHOLDS = { lcpMs: [2500, 4000], inpMs: [200, 500], cls: [0.1, 0.25] } as const;
const rate = (v: number, [good, poor]: readonly [number, number]) => (v <= good ? "good" : v <= poor ? "needs-improvement" : "poor");

type Metric = { percentile: number; category: string } | undefined;

function field(exp: { metrics?: Record<string, Metric>; overall_category?: string } | undefined) {
  const m = exp?.metrics;
  if (!m || !Object.keys(m).length) return null;
  const cls = m.CUMULATIVE_LAYOUT_SHIFT_SCORE;
  return {
    overall: exp?.overall_category ?? null,
    lcpMs: m.LARGEST_CONTENTFUL_PAINT_MS ? { p75: m.LARGEST_CONTENTFUL_PAINT_MS.percentile, rating: m.LARGEST_CONTENTFUL_PAINT_MS.category } : null,
    inpMs: m.INTERACTION_TO_NEXT_PAINT ? { p75: m.INTERACTION_TO_NEXT_PAINT.percentile, rating: m.INTERACTION_TO_NEXT_PAINT.category } : null,
    // The API reports CLS multiplied by 100.
    cls: cls ? { p75: cls.percentile / 100, rating: cls.category } : null,
  };
}

/** Core Web Vitals from the PageSpeed Insights API: real-user (CrUX) field data when Google has it, plus one Lighthouse lab run. */
export async function coreWebVitals(ctx: Ctx, input: { url: string; strategy?: "mobile" | "desktop" }) {
  const url = new URL(input.url);
  ctx.client.allowlist.check(url);
  const api = new URL(PSI);
  api.searchParams.set("url", url.href);
  api.searchParams.set("strategy", input.strategy ?? "mobile");
  api.searchParams.set("category", "performance");
  if (ctx.env.PAGESPEED_API_KEY) api.searchParams.set("key", ctx.env.PAGESPEED_API_KEY);

  await ctx.limiter.take("pagespeed");
  const res = await ctx.api(api, { signal: AbortSignal.timeout(90_000) });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    const msg = redact(json?.error?.message ?? res.statusText);
    const hint = res.status === 429 && !ctx.env.PAGESPEED_API_KEY ? " Calls without a key share a small daily quota; set PAGESPEED_API_KEY (free) to get your own." : "";
    throw new Error(`PageSpeed Insights returned HTTP ${res.status}: ${msg}${hint}`);
  }

  const lh = json.lighthouseResult ?? {};
  const audit = (id: string): number | null => lh.audits?.[id]?.numericValue ?? null;
  const lcp = audit("largest-contentful-paint"), cls = audit("cumulative-layout-shift");
  const score = lh.categories?.performance?.score;
  return {
    url: url.href,
    strategy: input.strategy ?? "mobile",
    source: "PageSpeed Insights API v5",
    field: {
      page: field(json.loadingExperience),
      origin: field(json.originLoadingExperience),
      note: "75th percentile of real Chrome users over the last 28 days (CrUX). Null means Google has too little traffic data for this page or origin.",
    },
    lab: {
      performanceScore: typeof score === "number" ? Math.round(score * 100) : null,
      lcpMs: lcp === null ? null : { value: Math.round(lcp), rating: rate(lcp, THRESHOLDS.lcpMs) },
      cls: cls === null ? null : { value: Number(cls.toFixed(3)), rating: rate(cls, THRESHOLDS.cls) },
      totalBlockingTimeMs: audit("total-blocking-time"),
      firstContentfulPaintMs: audit("first-contentful-paint"),
      speedIndexMs: audit("speed-index"),
      lighthouseVersion: lh.lighthouseVersion ?? null,
      fetchTime: lh.fetchTime ?? null,
      note: "One simulated Lighthouse load from Google's servers. INP needs real users, so lab data has none; total blocking time is the usual lab stand-in.",
    },
  };
}
