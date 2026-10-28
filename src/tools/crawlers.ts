import type { Ctx } from "../context.js";
import { Refusal } from "../safety.js";

export const DEFAULT_AGENTS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Googlebot"];

interface Rule { allow: boolean; path: string }
interface Group { agents: string[]; rules: Rule[] }
export interface Robots { groups: Group[]; sitemaps: string[] }

/** robots.txt as RFC 9309 reads it: consecutive user-agent lines share one group. */
export function parseRobots(text: string): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | undefined;
  let inAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.replace(/#.*/, "").trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !inAgents) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      inAgents = true;
    } else if (key === "sitemap") {
      sitemaps.push(value);
    } else {
      inAgents = false;
      if ((key === "allow" || key === "disallow") && current && value) current.rules.push({ allow: key === "allow", path: value });
    }
  }
  return { groups, sitemaps };
}

/** `*` matches any run of characters and a trailing `$` anchors the end, as in RFC 9309. */
function matches(pattern: string, path: string) {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${body.join(".*")}${anchored ? "$" : ""}`).test(path);
}

/**
 * The agent's own groups apply if any name it, else the `*` groups. The longest matching
 * rule wins, and Allow wins a tie. ponytail: exact token match only, no Googlebot-News style fallback.
 */
export function evaluate(robots: Robots, agent: string, path: string) {
  if (path === "/robots.txt") return { allowed: true, group: null, rule: null };
  const token = agent.toLowerCase();
  let groups = robots.groups.filter((g) => g.agents.includes(token));
  let group: string | null = agent;
  if (!groups.length) [groups, group] = [robots.groups.filter((g) => g.agents.includes("*")), "*"];
  if (!groups.length) group = null;
  let best: Rule | undefined;
  for (const r of groups.flatMap((g) => g.rules))
    if (matches(r.path, path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)))
      best = r;
  return { allowed: best ? best.allow : true, group, rule: best ? `${best.allow ? "Allow" : "Disallow"}: ${best.path}` : null };
}

/**
 * Crawlers read robots.txt only at the host root. Per RFC 9309 a 4xx means no rules (all
 * allowed) and a 5xx or network failure means the whole site is treated as disallowed.
 */
export async function loadRobots(ctx: Ctx, url: URL) {
  const robotsUrl = new URL("/robots.txt", url.origin).href;
  try {
    const page = await ctx.get(robotsUrl, { siteFile: true });
    if (page.status < 300) return { url: robotsUrl, status: page.status, state: "found" as const, robots: parseRobots(page.body) };
    if (page.status < 500) return { url: robotsUrl, status: page.status, state: "missing" as const, robots: parseRobots("") };
    return { url: robotsUrl, status: page.status, state: "unreachable" as const, robots: parseRobots("User-agent: *\nDisallow: /") };
  } catch (e) {
    if (e instanceof Refusal) throw e;
    return { url: robotsUrl, status: 0, state: "unreachable" as const, robots: parseRobots("User-agent: *\nDisallow: /"), error: (e as Error).message };
  }
}

const NOTES = {
  found: "Rules parsed from the file.",
  missing: "No robots.txt (4xx), so every crawler may fetch everything.",
  unreachable: "robots.txt could not be fetched (5xx or network error); compliant crawlers then treat the whole site as disallowed.",
};

async function probe(ctx: Ctx, url: string) {
  try {
    const p = await ctx.get(url, { siteFile: true });
    return { status: p.status, body: p.body, type: p.headers["content-type"] ?? "" };
  } catch (e) {
    if (e instanceof Refusal) throw e;
    return { status: 0, body: "", type: "", error: (e as Error).message };
  }
}

/** The llms.txt proposal: markdown at /llms.txt (or under a subpath), an H1 first, then optional summary and link sections. */
async function checkLlmsTxt(ctx: Ctx, url: string) {
  const p = await probe(ctx, url);
  const looksHtml = /html/i.test(p.type) || /^\s*</.test(p.body);
  const found = p.status === 200 && !looksHtml && p.body.trim().length > 0;
  if (!found) return { url, status: p.status, found, ...(looksHtml && p.status === 200 ? { problem: "Served HTML, not markdown." } : {}) };
  const lines = p.body.split(/\r?\n/);
  const first = lines.find((l) => l.trim()) ?? "";
  return {
    url,
    status: p.status,
    found,
    bytes: Buffer.byteLength(p.body),
    title: first.startsWith("# ") ? first.slice(2).trim() : null,
    hasSummary: lines.some((l) => l.startsWith("> ")),
    sections: lines.filter((l) => l.startsWith("## ")).length,
    links: (p.body.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length,
    ...(first.startsWith("# ") ? {} : { problem: "The first line should be an H1 (# Site name)." }),
  };
}

export async function checkCrawlerAccess(ctx: Ctx, input: { url: string; agents?: string[] }) {
  const url = new URL(input.url);
  ctx.client.allowlist.check(url);
  const base = ctx.client.allowlist.match(url) ?? "";
  const robots = await loadRobots(ctx, url);
  const path = url.pathname + url.search;
  const agents = [...new Set([...DEFAULT_AGENTS, ...(input.agents ?? [])])];

  // A site served under a path (as the demo sites are) may ship its own robots.txt there. Crawlers never read it.
  let subpathRobots;
  if (base) {
    const u = new URL(`${base}/robots.txt`, url.origin).href;
    const p = await probe(ctx, u);
    if (p.status === 200 && !/html/i.test(p.type))
      subpathRobots = { url: u, note: `A robots.txt exists at ${base}/robots.txt, but crawlers only read /robots.txt at the host root, so its rules have no effect.` };
  }

  return {
    url: url.href,
    path,
    robots: { url: robots.url, status: robots.status, state: robots.state, note: NOTES[robots.state], sitemaps: robots.robots.sitemaps },
    ...(subpathRobots ? { subpathRobots } : {}),
    agents: agents.map((agent) => ({ agent, ...evaluate(robots.robots, agent, path) })),
    llmsTxt: await Promise.all([new URL("/llms.txt", url.origin).href, ...(base ? [new URL(`${base}/llms.txt`, url.origin).href] : [])].map((u) => checkLlmsTxt(ctx, u))),
  };
}
