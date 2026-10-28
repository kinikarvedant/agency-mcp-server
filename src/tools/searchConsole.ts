import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { ROOT, type Env } from "../config.js";
import type { Ctx } from "../context.js";
import { redact, registerSecret, Refusal } from "../safety.js";

// Read-only scope: this server can never change a Search Console property.
export const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://searchconsole.googleapis.com/webmasters/v3/sites";

export type Dimension = "query" | "page" | "country" | "device" | "date";
export interface ReportInput { startDate: string; endDate: string; dimensions?: Dimension[]; rowLimit?: number }
interface Row { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** Which credentials are configured, if any. Neither means fixture mode. */
export function credentials(env: Env) {
  if (env.GSC_SERVICE_ACCOUNT_JSON) {
    const raw = env.GSC_SERVICE_ACCOUNT_JSON.trim().startsWith("{") ? env.GSC_SERVICE_ACCOUNT_JSON : readFileSync(env.GSC_SERVICE_ACCOUNT_JSON, "utf8");
    const key = JSON.parse(raw) as { client_email: string; private_key: string; token_uri?: string };
    registerSecret(key.private_key);
    return { kind: "service-account" as const, ...key };
  }
  if (env.GSC_OAUTH_CLIENT_ID && env.GSC_OAUTH_CLIENT_SECRET && env.GSC_OAUTH_REFRESH_TOKEN)
    return { kind: "oauth" as const, clientId: env.GSC_OAUTH_CLIENT_ID, clientSecret: env.GSC_OAUTH_CLIENT_SECRET, refreshToken: env.GSC_OAUTH_REFRESH_TOKEN };
  return null;
}

/** A signed JWT for the service-account flow (RFC 7523), built with node:crypto instead of a Google SDK. */
export function serviceAccountAssertion(key: { client_email: string; private_key: string; token_uri?: string }, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri ?? TOKEN_URL, iat, exp: iat + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(key.private_key, "base64url");
  return `${head}.${claims}.${sig}`;
}

let cached: { token: string; expires: number } | undefined;

async function accessToken(creds: NonNullable<ReturnType<typeof credentials>>, api: typeof fetch) {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const form: Record<string, string> =
    creds.kind === "service-account"
      ? { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountAssertion(creds) }
      : { grant_type: "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken };
  const res = await api(creds.kind === "service-account" ? (creds.token_uri ?? TOKEN_URL) : TOKEN_URL, { method: "POST", body: new URLSearchParams(form) });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !json.access_token) throw new Error(`Google token request failed (HTTP ${res.status}): ${redact(json.error_description ?? json.error ?? "no token")}`);
  registerSecret(json.access_token);
  cached = { token: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cached.token;
}

export function resetTokenCache() { cached = undefined; }

/** Aggregates fixture rows (query x page) to the requested dimensions, as the API would. */
function aggregate(rows: { query: string; page: string; clicks: number; impressions: number; position: number }[], dims: Dimension[], limit: number): Row[] {
  const groups = new Map<string, { keys: string[]; clicks: number; impressions: number; posSum: number }>();
  for (const r of rows) {
    const keys = dims.map((d) => r[d as "query" | "page"]);
    const g = groups.get(JSON.stringify(keys)) ?? { keys, clicks: 0, impressions: 0, posSum: 0 };
    g.clicks += r.clicks;
    g.impressions += r.impressions;
    g.posSum += r.position * r.impressions;
    groups.set(JSON.stringify(keys), g);
  }
  return [...groups.values()]
    .map((g) => ({ keys: g.keys, clicks: g.clicks, impressions: g.impressions, ctr: g.impressions ? g.clicks / g.impressions : 0, position: g.impressions ? g.posSum / g.impressions : 0 }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, limit);
}

export const FIXTURE_NOTICE =
  "FIXTURE DATA. No Search Console credentials are configured, so these rows come from a sample file bundled with the server " +
  "(fixtures/search-console.json). They are made up for demos and tests and say nothing about the real site. The date range is ignored.";

export async function searchConsoleReport(ctx: Ctx, input: ReportInput) {
  const dims = input.dimensions?.length ? input.dimensions : ["query" as const];
  const limit = input.rowLimit ?? 25;
  const creds = ctx.env.DEMO_MODE ? null : credentials(ctx.env);

  if (!creds) {
    if (dims.some((d) => d !== "query" && d !== "page")) throw new Refusal("Fixture mode supports the query and page dimensions only.");
    const fixture = JSON.parse(readFileSync(`${ROOT}fixtures/search-console.json`, "utf8"));
    const rows = fixture.clients[ctx.client.id];
    if (!rows) throw new Refusal(`No fixture rows for client "${ctx.client.id}".`);
    return { mode: "fixture" as const, notice: FIXTURE_NOTICE, property: ctx.client.searchConsoleProperty ?? null, dimensions: dims, rows: aggregate(rows, dims, limit) };
  }

  const property = ctx.client.searchConsoleProperty;
  if (!property) throw new Refusal(`Client "${ctx.client.id}" has no searchConsoleProperty configured.`);
  const token = await accessToken(creds, ctx.api);
  const res = await ctx.api(`${API}/${encodeURIComponent(property)}/searchAnalytics/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ startDate: input.startDate, endDate: input.endDate, dimensions: dims, rowLimit: limit }),
  });
  const json = (await res.json().catch(() => ({}))) as { rows?: Row[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Search Console returned HTTP ${res.status}: ${redact(json.error?.message ?? res.statusText)}`);
  return { mode: "live" as const, property, dimensions: dims, startDate: input.startDate, endDate: input.endDate, rows: json.rows ?? [] };
}
