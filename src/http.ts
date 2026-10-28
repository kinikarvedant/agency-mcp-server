import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { pathToFileURL } from "node:url";
import { loadConfig, ROOT, type Config } from "./config.js";
import type { Deps } from "./context.js";
import { log, RateLimiter } from "./safety.js";
import { createServer } from "./server.js";

/** Tool calls per visitor (20, refilled over 10 minutes) and for everyone together (300 an hour). */
export const playgroundLimits = () => ({ perIp: new RateLimiter(20, 20 / 600), global: new RateLimiter(300, 300 / 3600) });

/** Streamable HTTP (stateless, JSON responses) plus the static playground page. */
export function createApp(config: Config, deps: Deps = {}, limits = playgroundLimits()) {
  const app = express();
  const base = config.env.BASE_PATH;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.post(`${base}/mcp`, async (req, res) => {
    const calls = [req.body].flat().filter((m) => m?.method === "tools/call").length;
    // nginx sets X-Real-IP; the container is reachable only through it.
    const ip = String(req.headers["x-real-ip"] ?? req.socket.remoteAddress);
    for (let i = 0; i < calls; i++)
      if (!limits.perIp.tryTake(ip) || !limits.global.tryTake("all")) {
        log("warn", "rate limited", { ip });
        return void res.status(429).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32000, message: "Rate limit reached: the playground allows 20 tool calls per visitor every 10 minutes. Try again shortly." } });
      }
    const server = createServer(config, deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void Promise.all([transport.close(), server.close()]));
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all(`${base}/mcp`, (_req, res) => void res.status(405).set("allow", "POST").json({ error: "POST JSON-RPC here." }));

  app.get(`${base}/health`, (_req, res) => void res.json({ ok: true }));
  app.get(`${base}/clients`, (_req, res) =>
    void res.json([...config.clients.values()].map((c) => ({ id: c.id, name: c.name, allow: c.allow }))));
  app.use(base || "/", express.static(`${ROOT}playground`, { maxAge: "5m" }));
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  createApp(config).listen(config.env.PORT, () =>
    log("info", "http server ready", { port: config.env.PORT, base: config.env.BASE_PATH, demoMode: config.env.DEMO_MODE }));
}
