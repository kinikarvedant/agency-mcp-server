import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Allowlist } from "./safety.js";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

const optional = z.string().trim().min(1).optional().catch(undefined);

export const EnvSchema = z.object({
  CLIENTS_FILE: z.string().default(`${ROOT}config/clients.json`),
  /** Optional: PageSpeed Insights works without a key, at a low shared quota. */
  PAGESPEED_API_KEY: optional,
  /** Search Console: a service-account key (file path or inline JSON) ... */
  GSC_SERVICE_ACCOUNT_JSON: optional,
  /** ... or an OAuth client with a refresh token. Neither set means fixture mode. */
  GSC_OAUTH_CLIENT_ID: optional,
  GSC_OAUTH_CLIENT_SECRET: optional,
  GSC_OAUTH_REFRESH_TOKEN: optional,
  /** Any HTTPS endpoint that speaks the common chat-completions format. Unset means the mock provider. */
  MODEL_API_BASE_URL: z.url().optional().catch(undefined),
  MODEL_API_KEY: optional,
  MODEL_NAME: optional,
  /** Public playground: Search Console and the visibility check always use fixture / mock data. */
  DEMO_MODE: z.enum(["0", "1"]).default("0").transform((v) => v === "1"),
  FETCH_RATE_PER_SECOND: z.coerce.number().positive().max(10).default(2),
  MAX_CRAWL_PAGES: z.coerce.number().int().min(1).max(500).default(200),
  PORT: z.coerce.number().int().default(3000),
  BASE_PATH: z.string().regex(/^(\/[\w-]+)*$/).default(""),
});
export type Env = z.infer<typeof EnvSchema>;

const ClientSchema = z.object({
  name: z.string().min(1),
  /** Hostnames ("example.com", "*.example.com") or URL prefixes ("https://host/path"). */
  allow: z.array(z.string().min(1)).min(1),
  /** Names counted as a mention in the visibility check. Defaults to the client's name. */
  brandTerms: z.array(z.string().min(2)).optional(),
  /** Search Console property, "sc-domain:example.com" or a URL prefix. */
  searchConsoleProperty: z.string().optional(),
});
const ClientsSchema = z.record(z.string().regex(/^[a-z0-9-]+$/), ClientSchema);

export interface Client extends z.infer<typeof ClientSchema> {
  id: string;
  allowlist: Allowlist;
}

export interface Config {
  env: Env;
  clients: Map<string, Client>;
}

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): Config {
  const env = EnvSchema.parse(raw);
  return { env, clients: parseClients(JSON.parse(readFileSync(env.CLIENTS_FILE, "utf8"))) };
}

export function parseClients(json: unknown): Map<string, Client> {
  const parsed = ClientsSchema.parse(json);
  return new Map(Object.entries(parsed).map(([id, c]) => [id, { ...c, id, allowlist: new Allowlist(c.allow) }]));
}
