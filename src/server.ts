#!/usr/bin/env node
// Naira Reach website with the agent behind it. Run with: npm run app
// Listens on this computer only. Nobody else on the network can reach it.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { settings } from "./config.ts";
import { publicClient } from "./executor.ts";
import { TextileClient } from "./textile.ts";
import { createWebApp } from "./web.ts";

const port = Number(process.env.NAIRA_REACH_PORT ?? "8787");
const handle = createWebApp({
  webDir: fileURLToPath(new URL("../web/", import.meta.url)),
  port,
  // A fresh token every run: only the page this server hands out can use the agent.
  token: randomBytes(24).toString("hex"),
  textile: new TextileClient(settings.textileUrl(), settings.textileKey()),
  reader: publicClient(settings.rpcUrl()),
});

const server = createServer((req, res) => void handle(req, res));
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use. Is Naira Reach already open in another window?` : e.message);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Naira Reach is running. Open http://localhost:${port}`);
  console.log("Keep this window open while you use the site. Close it (Ctrl+C) to stop the agent.");
});
