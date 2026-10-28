import { generateKeyPairSync, createVerify } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { makeCtx } from "../src/context.js";
import { resetTokenCache, SCOPE, searchConsoleReport, serviceAccountAssertion } from "../src/tools/searchConsole.js";
import { answerEngineVisibility, mockProvider, newcombe, wilson } from "../src/tools/visibility.js";
import { coreWebVitals } from "../src/tools/vitals.js";
import { fakeApi, localDeps, testConfig } from "./helpers.js";

const CLIENTS = {
  dental: { name: "Bridge Road Dental Care", allow: ["https://site.test/dental"], brandTerms: ["Bridge Road Dental"], searchConsoleProperty: "sc-domain:site.test" },
};
const ctxWith = (env: Record<string, string>, api?: typeof fetch) => makeCtx(testConfig(CLIENTS, env), "dental", localDeps({ api }));

// A trimmed PageSpeed Insights v5 response with the fields the tool reads. Synthetic values for the test only.
const PSI_RESPONSE = {
  loadingExperience: {
    overall_category: "FAST",
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2100, category: "FAST" },
      INTERACTION_TO_NEXT_PAINT: { percentile: 150, category: "FAST" },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: "FAST" },
    },
  },
  originLoadingExperience: { metrics: {} },
  lighthouseResult: {
    lighthouseVersion: "12.0.0",
    fetchTime: "2026-10-28T00:00:00.000Z",
    categories: { performance: { score: 0.91 } },
    audits: {
      "largest-contentful-paint": { numericValue: 4500.4 },
      "cumulative-layout-shift": { numericValue: 0.12345 },
      "total-blocking-time": { numericValue: 120 },
      "first-contentful-paint": { numericValue: 1000 },
      "speed-index": { numericValue: 2000 },
    },
  },
};

describe("core_web_vitals", () => {
  it("calls PageSpeed Insights and separates field from lab data", async () => {
    const { api, calls } = fakeApi(() => ({ json: PSI_RESPONSE }));
    const r = await coreWebVitals(ctxWith({ PAGESPEED_API_KEY: "test-psi-key" }, api), { url: "https://site.test/dental", strategy: "desktop" });
    const sent = new URL(calls[0].url);
    expect(sent.origin + sent.pathname).toBe("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
    expect(Object.fromEntries(sent.searchParams)).toEqual({ url: "https://site.test/dental", strategy: "desktop", category: "performance", key: "test-psi-key" });
    expect(r.field.page).toEqual({ overall: "FAST", lcpMs: { p75: 2100, rating: "FAST" }, inpMs: { p75: 150, rating: "FAST" }, cls: { p75: 0.05, rating: "FAST" } });
    expect(r.field.origin).toBeNull();
    expect(r.lab).toMatchObject({ performanceScore: 91, lcpMs: { value: 4500, rating: "poor" }, cls: { value: 0.123, rating: "needs-improvement" } });
  });

  it("works without a key and explains a quota error without leaking the URL", async () => {
    const { api, calls } = fakeApi(() => ({ status: 429, json: { error: { message: "Quota exceeded for quota metric 'Queries'" } } }));
    await expect(coreWebVitals(ctxWith({}, api), { url: "https://site.test/dental" })).rejects.toThrow(/HTTP 429: Quota exceeded.*set PAGESPEED_API_KEY/);
    expect(new URL(calls[0].url).searchParams.has("key")).toBe(false);
  });

  it("refuses URLs outside the allowlist without calling Google", async () => {
    const { api, calls } = fakeApi(() => ({ json: {} }));
    await expect(coreWebVitals(ctxWith({}, api), { url: "https://site.test/other" })).rejects.toThrow(/outside/);
    expect(calls).toHaveLength(0);
  });
});

describe("search_console_report", () => {
  beforeEach(resetTokenCache);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const serviceAccount = JSON.stringify({ client_email: "reader@test.iam.gserviceaccount.com", private_key: privateKey, token_uri: "https://oauth2.googleapis.com/token" });

  it("returns labelled fixture rows when no credentials are set", async () => {
    const r = await searchConsoleReport(ctxWith({}), { startDate: "2026-09-01", endDate: "2026-09-30", dimensions: ["query"], rowLimit: 3 });
    expect(r.mode).toBe("fixture");
    expect("notice" in r && r.notice).toMatch(/^FIXTURE DATA\..*made up/);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toMatchObject({ keys: ["emergency dentist richmond"], clicks: 40, impressions: 800, ctr: 0.05, position: 4 });
  });

  it("aggregates fixture rows across pages with impression-weighted position", async () => {
    const r = await searchConsoleReport(ctxWith({}), { startDate: "2026-09-01", endDate: "2026-09-30", dimensions: ["query"], rowLimit: 100 });
    expect(r.rows.find((x) => x.keys[0] === "kids dentist cremorne")).toEqual({ keys: ["kids dentist cremorne"], clicks: 10, impressions: 200, ctr: 0.05, position: 6 });
  });

  it("uses fixtures in demo mode even when credentials exist", async () => {
    const { api, calls } = fakeApi(() => ({ json: {} }));
    const r = await searchConsoleReport(ctxWith({ DEMO_MODE: "1", GSC_SERVICE_ACCOUNT_JSON: serviceAccount }, api), { startDate: "2026-09-01", endDate: "2026-09-30" });
    expect(r.mode).toBe("fixture");
    expect(calls).toHaveLength(0);
  });

  it("signs a read-only service-account JWT", () => {
    const jwt = serviceAccountAssertion(JSON.parse(serviceAccount), Date.UTC(2026, 9, 28));
    const [head, claims, sig] = jwt.split(".");
    expect(createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(publicKey, sig, "base64url")).toBe(true);
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: "reader@test.iam.gserviceaccount.com", scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: 1793145600, exp: 1793149200,
    });
    expect(SCOPE).toBe("https://www.googleapis.com/auth/webmasters.readonly");
  });

  it("builds the live request: token exchange, then a POST to searchAnalytics/query", async () => {
    const { api, calls } = fakeApi((url) =>
      url.includes("oauth2") ? { json: { access_token: "ya29.test-token", expires_in: 3600 } } : { json: { rows: [{ keys: ["a"], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }] } });
    const r = await searchConsoleReport(ctxWith({ GSC_SERVICE_ACCOUNT_JSON: serviceAccount }, api), { startDate: "2026-09-01", endDate: "2026-09-30", dimensions: ["page"], rowLimit: 10 });
    expect(calls.map((c) => c.url)).toEqual(["https://oauth2.googleapis.com/token", "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Asite.test/searchAnalytics/query"]);
    expect(new URLSearchParams(calls[0].init!.body as URLSearchParams).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect((calls[1].init!.headers as Record<string, string>).authorization).toBe("Bearer ya29.test-token");
    expect(JSON.parse(calls[1].init!.body as string)).toEqual({ startDate: "2026-09-01", endDate: "2026-09-30", dimensions: ["page"], rowLimit: 10 });
    expect(r).toMatchObject({ mode: "live", property: "sc-domain:site.test", rows: [{ keys: ["a"] }] });
  });

  it("supports the OAuth refresh-token flow and redacts secrets from errors", async () => {
    const { api, calls } = fakeApi(() => ({ status: 400, json: { error: "invalid_grant", error_description: "Bad refresh token 1//secret-refresh" } }));
    const env = { GSC_OAUTH_CLIENT_ID: "id.apps.googleusercontent.com", GSC_OAUTH_CLIENT_SECRET: "client-secret-x", GSC_OAUTH_REFRESH_TOKEN: "1//secret-refresh" };
    await expect(searchConsoleReport(ctxWith(env, api), { startDate: "2026-09-01", endDate: "2026-09-30" })).rejects.toThrow(/\(HTTP 400\): Bad refresh token \[redacted\]$/);
    expect(new URLSearchParams(calls[0].init!.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
  });
});

describe("answer_engine_visibility", () => {
  it("computes Wilson and Newcombe intervals matching published values", () => {
    const r = (x: number[]) => x.map((v) => Math.round(v * 10000) / 10000);
    expect(r(wilson(0, 10))).toEqual([0, 0.2775]);
    expect(r(wilson(5, 10))).toEqual([0.2366, 0.7634]);
    // Newcombe (1998), table II example (56/70 vs 48/80): 0.0524 to 0.3339.
    expect(r(newcombe(56, 70, 48, 80))).toEqual([0.0524, 0.3339]);
  });

  it("uses the labelled mock provider without an endpoint, deterministically", async () => {
    const ctx = ctxWith({});
    const input = { prompts: ["best dentist in richmond", "emergency dentist open saturday"], runs: 10 };
    const a = await answerEngineVisibility(ctx, input);
    const b = await answerEngineVisibility(ctx, input);
    expect(a).toEqual(b);
    expect(a.mode).toBe("mock");
    expect(a.notice).toMatch(/^MOCK PROVIDER\. No language model was called/);
    for (const p of a.prompts) if (p.firstMentionExcerpt) expect(p.firstMentionExcerpt).toMatch(/^\[MOCK REPLY/);
    expect(a.overall.runs).toBe(20);
  });

  it("separates a real change from run-to-run variance", async () => {
    const always = { mode: "live" as const, name: "fake", ask: async () => "Try Bridge Road Dental on Bridge Road." };
    const r = await answerEngineVisibility(ctxWith({}), {
      prompts: ["p1", "p2"], runs: 20,
      baseline: [{ prompt: "p1", mentions: 2, runs: 20 }, { prompt: "p2", mentions: 18, runs: 20 }],
    }, always);
    expect(r.prompts[0]).toMatchObject({ mentions: 20, rate: 1, change: { verdict: expect.stringMatching(/^real change/) } });
    expect(r.prompts[1].change!.verdict).toMatch(/^within run-to-run variance/);
  });

  it("matches brand terms as whole words, case-insensitively", async () => {
    const replies = ["bridge road dental is good", "Bridge Road Dentalist", "Visit BRIDGE ROAD DENTAL.", "nothing here"];
    let i = 0;
    const p = { mode: "live" as const, name: "fake", ask: async () => replies[i++] };
    const r = await answerEngineVisibility(ctxWith({}), { prompts: ["q"], runs: 4 }, p);
    expect(r.prompts[0].mentions).toBe(2);
  });

  it("sends only the operator's prompt to a configured chat-completions endpoint", async () => {
    const { api, calls } = fakeApi(() => ({ json: { choices: [{ message: { content: "Bridge Road Dental is one option." } }] } }));
    const env = { MODEL_API_BASE_URL: "https://models.example.test/v1/", MODEL_API_KEY: "model-key-123", MODEL_NAME: "some-model" };
    const r = await answerEngineVisibility(ctxWith(env, api), { prompts: ["dentist near bridge road"], runs: 2 });
    expect(r).toMatchObject({ mode: "live", provider: "some-model", prompts: [{ mentions: 2 }] });
    expect(calls[0].url).toBe("https://models.example.test/v1/chat/completions");
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ model: "some-model", messages: [{ role: "user", content: "dentist near bridge road" }] });
    expect((calls[0].init!.headers as Record<string, string>).authorization).toBe("Bearer model-key-123");
  });

  it("never runs the mock in a way that looks like real output", async () => {
    const reply = await mockProvider("X").ask("p", 1);
    expect(reply).toMatch(/^\[MOCK REPLY 1: no language model was called\]/);
  });
});
