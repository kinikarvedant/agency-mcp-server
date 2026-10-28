import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Refusal, type RateLimiter } from "./safety.js";

export const USER_AGENT = "AgencyAuditBot/0.1 (+https://github.com/kinikarvedant/agency-mcp-server)";

// Private, loopback, link-local, shared (CGNAT, which includes Tailscale), documentation,
// multicast and reserved ranges. IPv4-mapped and NAT64 IPv6 are blocked whole, since they
// can carry any IPv4 address; ordinary lookups never return them for public hosts.
// Two lists: a BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules.
const V4 = new net.BlockList();
const V6 = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) V4.addSubnet(a, p, "ipv4");
for (const [a, p] of [
  ["::", 127], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) V6.addSubnet(a, p, "ipv6");

export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true;
  return family === 4 ? V4.check(ip, "ipv4") : V6.check(ip, "ipv6");
}

export interface Page {
  url: string; // final URL after redirects
  status: number;
  headers: Record<string, string>;
  body: string;
  redirects: { from: string; to: string; status: number }[];
}

export interface GetOptions {
  /** Throws a Refusal if the URL may not be fetched; runs for the first URL and every redirect. */
  check: (url: URL) => void;
  limiter?: RateLimiter;
  lookup?: typeof dns.lookup;
  /** Addresses exempt from the private-range block. Tests only: a local fixture server. */
  trusted?: string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

type LookupCb = (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * The address check runs inside the socket's own DNS lookup, so the address that is checked is
 * the address that is connected to (no gap for a rebinding answer between check and connect).
 */
function guardedLookup(resolve: typeof dns.lookup, trusted: Set<string>) {
  return (hostname: string, options: dns.LookupOptions, cb: LookupCb) => {
    resolve(hostname, { all: true, family: options.family }, (err, addrs) => {
      if (err) return cb(err, "");
      const bad = addrs.find((a) => isBlockedAddress(a.address) && !trusted.has(a.address));
      if (bad) return cb(new Refusal(`${hostname} resolves to ${bad.address}, a private or reserved address`), "");
      if (options.all) cb(null, addrs);
      else cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

function request(url: URL, o: GetOptions, trusted: Set<string>): Promise<Omit<Page, "url" | "redirects">> {
  const mod = url.protocol === "https:" ? https : http;
  const maxBytes = o.maxBytes ?? 2_000_000;
  return new Promise((resolve, reject) => {
    const req = mod.get(
      url,
      {
        lookup: guardedLookup(o.lookup ?? dns.lookup, trusted) as never,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
        timeout: o.timeoutMs ?? 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= maxBytes) return void chunks.push(c);
          reject(new Refusal(`${url.href} is larger than ${maxBytes} bytes`)); // settles first, so "end" cannot resolve it
          req.destroy();
        });
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = String(v);
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`${url.href} timed out`)));
    req.on("error", reject);
  });
}

/** GET only: nothing in this server can change a site. */
export async function safeGet(start: string | URL, o: GetOptions): Promise<Page> {
  const trusted = new Set(o.trusted ?? []);
  const redirects: Page["redirects"] = [];
  let url = new URL(start);
  for (;;) {
    o.check(url);
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    // IP literals skip DNS, so the lookup guard never sees them.
    if (net.isIP(literal) && isBlockedAddress(literal) && !trusted.has(literal))
      throw new Refusal(`${url.host} is a private or reserved address`);
    await o.limiter?.take(url.host);
    const res = await request(url, o, trusted);
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      if (redirects.length >= (o.maxRedirects ?? 5)) throw new Error(`${start} redirected too many times`);
      const next = new URL(location, url);
      redirects.push({ from: url.href, to: next.href, status: res.status });
      url = next;
      continue;
    }
    return { url: url.href, ...res, redirects };
  }
}
