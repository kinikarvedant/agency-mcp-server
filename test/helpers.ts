import type dns from "node:dns";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll } from "vitest";
import { EnvSchema, parseClients, type Config } from "../src/config.js";
import { makeCtx, type Deps } from "../src/context.js";
import { RateLimiter } from "../src/safety.js";

export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

export interface Route { status?: number; type?: string; body?: string; location?: string }

/**
 * A local site at http://site.test:<port>. Routes may be functions of the origin, for bodies
 * (sitemaps, redirects) that need absolute URLs. Unknown paths are an HTML 404.
 */
export async function fixtureSite(routes: Record<string, Route | ((origin: string) => Route)>) {
  let origin = "";
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url!);
    const r0 = routes[req.url!];
    const r = typeof r0 === "function" ? r0(origin) : r0;
    if (!r) return void res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
    res.writeHead(r.status ?? (r.location ? 302 : 200), { "content-type": r.type ?? "text/html; charset=utf-8", ...(r.location ? { location: r.location } : {}) });
    res.end(r.body ?? "");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  origin = `http://site.test:${port}`;
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));
  return { origin, port, hits };
}

/** DNS stand-in: names map to whatever address the test wants, hostile ones included. */
export function fakeLookup(map: Record<string, string>): typeof dns.lookup {
  return ((host: string, opts: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
    const address = map[host];
    if (!address) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
    const family = address.includes(":") ? 6 : 4;
    if (opts.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as never;
}

export function testConfig(clients: Record<string, unknown>, env: Record<string, string> = {}): Config {
  return { env: EnvSchema.parse({ CLIENTS_FILE: "unused", ...env }), clients: parseClients(clients) };
}

/** Deps that let the guarded fetcher reach the local fixture server, and nothing else private. */
export const localDeps = (extra: Partial<Deps> = {}): Deps => ({
  lookup: fakeLookup({ "site.test": "127.0.0.1" }),
  trusted: ["127.0.0.1"],
  limiter: new RateLimiter(1000, 1000),
  ...extra,
});

export function siteCtx(origin: string, env: Record<string, string> = {}, deps: Partial<Deps> = {}) {
  const config = testConfig({ c: { name: "Test Dental", allow: [origin] } }, env);
  return makeCtx(config, "c", localDeps(deps));
}

/** A fetch stand-in for the fixed third-party APIs, recording what was sent. */
export function fakeApi(handler: (url: string, init?: RequestInit) => { status?: number; json: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const api = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { api, calls };
}
