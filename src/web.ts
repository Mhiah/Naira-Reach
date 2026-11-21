// The website's link to the agent on the client's own computer (127.0.0.1). It
// serves the site and hands the Send side's requests to the agent core
// (src/agent.ts), the same core the online site runs in the client's browser.
//
// Other websites must not be able to drive it, so every request is checked:
//  - Host must be this computer (stops DNS rebinding)
//  - API calls must carry this run's token, which only the page served here has
//  - anything that changes state must come from this page's own origin
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { PublicClient } from "viem";
import { AgentError, createAgent, type Actions, type Json } from "./agent.ts";
import { attributionCode, privateKey, settings } from "./config.ts";
import { anthropicExtractor } from "./invoice.ts";
import { store } from "./store.ts";
import type { TextileClient } from "./textile.ts";
import { newVaultKey, seal } from "./vault.ts";

export type { Actions } from "./agent.ts";

export type WebOptions = {
  webDir: string;
  port: number;
  token: string;
  textile: TextileClient;
  reader: PublicClient;
  actions?: Partial<Actions>;
  now?: () => number;
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const MAX_BODY = 2 * 1024 * 1024;

/** What moves to the online site. Uploaded invoices and revoked keys stay behind. */
const EXPORTED = ["client.json", "session.json", "session.key", "taker-proof.json", "freelancers.json", "ledger.json", "holds.json"];

const code = () => {
  try {
    return attributionCode();
  } catch {
    return null;
  }
};

export function createWebApp(o: WebOptions) {
  const webDir = resolve(o.webDir);
  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const rpcOrigin = safeOrigin(settings.rpcUrl());
  const anthropicKey = settings.anthropicKey();
  const agent = createAgent({
    textile: o.textile,
    textileKeyless: !settings.textileKey(),
    reader: o.reader,
    adminKey: () => privateKey("CLIENT_ADMIN_PRIVATE_KEY", "Add your wallet key to .env first: npm run reach -- wallet new-key"),
    hasAdminKey: () => Boolean(process.env.CLIENT_ADMIN_PRIVATE_KEY?.trim()),
    attributionCode: code,
    clientName: () => settings.clientName() ?? null,
    maxInvoiceUsdt: settings.maxInvoiceUsdt(),
    gasTopUpUsdt: settings.gasTopUpUsdt(),
    announcer: settings.announcer(),
    extractor: anthropicKey ? anthropicExtractor(anthropicKey, settings.anthropicModel()) : undefined,
    actions: o.actions,
    now: o.now,
  });

  /**
   * The agent in a locked file, for the online site's "Bring your agent from
   * your laptop". Locked with the client's password before it leaves this server.
   */
  async function exportAgent(body: Record<string, unknown>) {
    const password = String(body.password ?? "");
    if (password !== String(body.repeat ?? "")) throw new HttpError(400, "The two passwords don't match.");
    const records: Record<string, unknown> = {};
    for (const name of EXPORTED) if (store().exists(name)) records[name] = store().read(name, null);
    for (const name of store().list("receipts/")) if (name.endsWith(".json")) records[name] = store().read(name, null);
    records["admin.key"] = { privateKey: privateKey("CLIENT_ADMIN_PRIVATE_KEY", "There's no wallet key on this computer to move.") };
    const clientName = settings.clientName();
    if (clientName) records["profile.json"] = { clientName };
    const vk = await newVaultKey(password);
    return seal({ v: 1, exportedAt: new Date().toISOString(), records }, vk);
  }

  function serveStatic(url: URL, res: ServerResponse) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = resolve(webDir, `.${rel}`);
    if (!file.startsWith(webDir + sep) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "Not found.");
    // The online site's helpers are not part of the site on this computer.
    if (rel.startsWith("/api/") || rel === "/vercel.json") throw new HttpError(404, "Not found.");
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    let content: Buffer | string = readFileSync(file);
    if (rel === "/index.html") {
      const cfg = JSON.stringify({ agent: true, token: o.token, attributionCode: code(), rpcUrl: settings.rpcUrl() }).replace(/</g, "\\u003c");
      content = content.toString("utf8").replace('<script src="config.js"></script>', `<script>window.NR_CONFIG=${cfg}</script>`);
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": rel === "/index.html" ? "no-store" : "no-cache",
      ...securityHeaders(rpcOrigin),
    });
    res.end(content);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      if (!allowedHosts.has(String(req.headers.host ?? ""))) throw new HttpError(403, "Open this page at http://localhost:" + o.port);
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Not allowed.");
        return serveStatic(url, res);
      }
      if (req.headers["x-naira-reach-token"] !== o.token) throw new HttpError(403, "This page is out of date. Reload it.");
      if (req.method !== "GET") {
        const origin = req.headers.origin;
        if (origin !== undefined && !allowedOrigins.has(origin)) throw new HttpError(403, "Requests from other websites are refused.");
        // A POST that is not JSON could come from a plain form on another site, without a preflight.
        if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          throw new HttpError(415, "Send JSON.");
        }
      }
      const body = req.method === "POST" ? await readBody(req) : {};
      if (req.method === "POST" && url.pathname === "/api/export") return send(res, 200, await exportAgent(body), rpcOrigin);
      const out: Json = await agent.dispatch(req.method ?? "GET", url.pathname.slice("/api".length), body);
      send(res, 200, out, rpcOrigin);
    } catch (e) {
      const status = e instanceof HttpError || e instanceof AgentError ? e.status : 400;
      send(res, status, { error: (e as Error).message || String(e) }, rpcOrigin);
    }
  };
}

// ---------- small helpers ----------

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "https://forno.celo.org";
  }
}

function securityHeaders(rpcOrigin: string): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' ${rpcOrigin}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
  };
}

function send(res: ServerResponse, status: number, body: unknown, rpcOrigin: string) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...securityHeaders(rpcOrigin) });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Too large.");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Couldn't read that request.");
  }
}
