#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { log } from "./safety.js";
import { createServer } from "./server.js";

const config = loadConfig();
await createServer(config).connect(new StdioServerTransport());
log("info", "stdio server ready", { clients: [...config.clients.keys()], demoMode: config.env.DEMO_MODE });
