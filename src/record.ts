// Records a real MCP session: the SDK's reference client starts the stdio server, lists the tools
// and calls each one against the live demo sites. Every JSON-RPC message is captured as sent.
// Output: playground/transcript.json (served by the playground) and docs/mcp-session.md.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { ROOT } from "./config.js";
import { VERSION } from "./server.js";

const D = "https://vedantkinikar.duckdns.org/demos";
const STEPS: [string, Record<string, unknown>][] = [
  ["audit_page", { client: "dental", url: `${D}/dental` }],
  ["validate_structured_data", { client: "plumber", url: `${D}/plumber/services/emergency-plumber` }],
  ["check_crawler_access", { client: "cafe", url: `${D}/cafe` }],
  ["core_web_vitals", { client: "dental", url: `${D}/dental`, strategy: "mobile" }],
  ["crawl_site", { client: "cafe", url: `${D}/cafe`, maxPages: 30 }],
  ["score_answerability", { client: "dental", url: `${D}/dental/services/emergency-dentist` }],
  ["search_console_report", { client: "plumber", startDate: "2026-09-01", endDate: "2026-09-30", dimensions: ["query"], rowLimit: 5 }],
  ["answer_engine_visibility", { client: "dental", prompts: ["Which dentist on Bridge Road in Richmond can see a cracked tooth today?"], runs: 10, baseline: [{ prompt: "Which dentist on Bridge Road in Richmond can see a cracked tooth today?", mentions: 1, runs: 10 }] }],
  ["audit_page", { client: "dental", url: `${D}/cafe` }], // another client's site: refused
  ["audit_page", { client: "dental", url: "http://169.254.169.254/latest/meta-data/" }], // cloud metadata address: refused
];

const messages: { from: "client" | "server"; ms: number; message: JSONRPCMessage }[] = [];
const t0 = Date.now();
// DEMO_MODE and a bare environment: no keys can reach the recorded server, so tools 7 and 8 run in fixture and mock mode.
const real = new StdioClientTransport({ command: process.execPath, args: [`${ROOT}dist/stdio.js`], env: { ...getDefaultEnvironment(), DEMO_MODE: "1" }, stderr: "inherit" });
const record = (from: "client" | "server", message: JSONRPCMessage) => messages.push({ from, ms: Date.now() - t0, message });
// Records what the client sends and what the server sends back, and otherwise passes through.
const transport = new Proxy(real, {
  get(t, p) {
    if (p === "send") return (m: JSONRPCMessage) => (record("client", m), t.send(m));
    const v = Reflect.get(t, p);
    return typeof v === "function" ? v.bind(t) : v;
  },
  set(t, p, v) {
    if (p === "onmessage") t.onmessage = (m) => (record("server", m), v?.(m));
    else Reflect.set(t, p, v);
    return true;
  },
});

const client = new Client({ name: "session-recorder", version: VERSION });
await client.connect(transport);
await client.listTools();
for (const [name, args] of STEPS) await client.callTool({ name, arguments: args });
await client.close();

const recordedAt = new Date().toISOString();
const note = `A real session between the MCP TypeScript SDK's client (driven by src/record.ts, no language model involved) and agency-mcp-server ${VERSION} over stdio, against the three fictional demo sites. Search Console ran in fixture mode and the visibility check used the mock provider, as their results say.`;
writeFileSync(`${ROOT}playground/transcript.json`, JSON.stringify({ recordedAt, note, messages }, null, 1) + "\n");

const CAP = 5000;
const md = [`# Recorded MCP session`, "", note, "", `Recorded ${recordedAt}. The playground renders the same file: \`playground/transcript.json\`.`, ""];
const names = new Map<unknown, string>();
for (const { from, ms, message } of messages) {
  const m = message as Record<string, any>;
  if (m.method) names.set(m.id, m.method === "tools/call" ? `tools/call ${m.params.name}` : m.method);
  const title = m.method ? `${m.method}${m.params?.name ? ` ${m.params.name}` : ""}` : `result of ${names.get(m.id)}${m.result?.isError ? " (error)" : ""}`;
  // Tool results carry the same data twice (fenced text and structuredContent); the Markdown shows the structured copy.
  const shown = m.result?.structuredContent ? { ...m, result: { content: "[fenced text omitted here; see transcript.json]", structuredContent: m.result.structuredContent } } : m;
  let json = JSON.stringify(shown, null, 2);
  if (json.length > CAP) json = `${json.slice(0, CAP)}\n… truncated here; the full message is in playground/transcript.json`;
  md.push(`### ${from === "client" ? "→" : "←"} ${title} (+${ms} ms)`, "", "```json", json, "```", "");
}
mkdirSync(`${ROOT}docs`, { recursive: true });
writeFileSync(`${ROOT}docs/mcp-session.md`, md.join("\n"));
console.error(`recorded ${messages.length} messages`);
