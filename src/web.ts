// The website's link to the agent. Runs on the client's own computer only
// (127.0.0.1), serves the site, and answers the Send side's requests with the
// same code the command line uses. The Receive side needs none of this: a
// freelancer's keys live in their own browser.
//
// Other websites must not be able to drive it, so every request is checked:
//  - Host must be this computer (stops DNS rebinding)
//  - API calls must carry this run's token, which only the page served here has
//  - anything that changes state must come from this page's own origin
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { agentPageUrl } from "@altananetwork/sdk";
import { erc20Abi, formatUnits, getAddress, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activateClientWallet, grantAgentSession, loadAgentSession, loadClientRecord, refreshTakerProof, revokeAgentSession, storedSession } from "./altana.ts";
import { CELO_CHAIN_ID, DECIMALS, ERC8004_IDENTITY_REGISTRY, EXPLORER_TX, TEXTILE_REACTOR, TOKENS } from "./celo.ts";
import { loadFreelancers, loadHolds, loadLedger, recordHold, saveFreelancers, type Freelancer, type PaidEntry } from "./checks.ts";
import { attributionCode, privateKey, readJson, receiptsDir, settings, statePath } from "./config.ts";
import { AltanaExecutor } from "./executor.ts";
import { anthropicExtractor } from "./invoice.ts";
import { payInvoice, reviewInvoice, type PayOutcome } from "./pay.ts";
import { storedProofInfo } from "./proof.ts";
import { parseMetaAddress } from "./stealth.ts";
import type { TextileClient } from "./textile.ts";

/** Everything that signs with the client's key or moves money. Tests replace these. */
export type Actions = {
  walletSetup: () => Promise<unknown>;
  grant: (limits: { usdtPerWeek: number; cngnPerWeek: number; days: number }) => Promise<unknown>;
  revoke: () => Promise<unknown>;
  proofRefresh: () => Promise<unknown>;
  pay: (invoicePath: string, opts: { approvedUsdt: number; approveHolds: boolean }) => Promise<PayOutcome>;
};

export type WebOptions = {
  webDir: string;
  port: number;
  token: string;
  textile: TextileClient;
  reader: PublicClient;
  actions?: Partial<Actions>;
  now?: () => number;
};

type Json = Record<string, unknown> | unknown[];

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
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const INVOICE_ID = /^[a-f0-9]{16}\.(json|txt)$/;
const RECEIPT_NAME = /^[A-Za-z0-9_-]+-\d+\.json$/;
const MAX_UPLOAD = 1024 * 1024;

export function createWebApp(o: WebOptions) {
  const now = o.now ?? (() => Date.now());
  const webDir = resolve(o.webDir);
  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const rpcOrigin = safeOrigin(settings.rpcUrl());
  const actions: Actions = { ...defaultActions(o), ...o.actions };
  let busy: string | undefined;
  let rateCache: { at: number; value: Rate } | undefined;

  async function exclusive<T>(what: string, fn: () => Promise<T>): Promise<T> {
    if (busy) throw new HttpError(409, `Still busy with: ${busy}. Wait for it to finish.`);
    busy = what;
    try {
      return await fn();
    } finally {
      busy = undefined;
    }
  }

  // ---------- state the Send side shows ----------

  function weekStart(t: number): number {
    // Monday 00:00 UTC.
    const d = new Date(t);
    const day = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  }

  function receiptOf(entry: PaidEntry): Receipt | undefined {
    try {
      return readJson<Receipt | undefined>(entry.receipt, undefined);
    } catch {
      return undefined;
    }
  }

  function usedThisWeek(ledger: PaidEntry[]) {
    const from = weekStart(now());
    let usdt = 0;
    let cngn = 0;
    for (const e of ledger) {
      if (Date.parse(e.paidAt) < from) continue;
      const r = receiptOf(e);
      cngn += e.amountNgn;
      usdt += (r?.cost?.usdt ?? 0) + (r?.payout?.gasMoneyUsdt ?? 0);
    }
    return { usdt, cngn, since: from };
  }

  function sessionView(ledger: PaidEntry[]) {
    const s = storedSession();
    if (!s) return null;
    const spend = (token: Address) => s.permissions.spend?.find((x) => x.token && getAddress(x.token) === getAddress(token));
    const usdtLimit = spend(TOKENS.USDT);
    const cngnLimit = spend(TOKENS.CNGN);
    const used = usedThisWeek(ledger);
    return {
      expiresAt: s.expiry * 1000,
      expired: s.expiry * 1000 <= now(),
      usdtPerWeek: usdtLimit ? Number(formatUnits(BigInt(usdtLimit.limit), DECIMALS.USDT)) : null,
      cngnPerWeek: cngnLimit ? Number(formatUnits(BigInt(cngnLimit.limit), DECIMALS.CNGN)) : null,
      used,
      calls: (s.permissions.calls ?? []).map(describeCall),
    };
  }

  function weekLeft(ledger: PaidEntry[]) {
    const s = sessionView(ledger);
    if (!s || s.expired || s.usdtPerWeek === null || s.cngnPerWeek === null) return undefined;
    return { usdt: Math.max(0, s.usdtPerWeek - s.used.usdt), cngn: Math.max(0, s.cngnPerWeek - s.used.cngn) };
  }

  function walletAddress(): Address | undefined {
    const recorded = loadClientRecord().walletAddress;
    if (recorded) return recorded;
    // Before setup the wallet address is the client key's address (EIP-7702). Only the address leaves here.
    try {
      return privateKeyToAccount(privateKey("CLIENT_ADMIN_PRIVATE_KEY", "")).address;
    } catch {
      return undefined;
    }
  }

  async function rate(): Promise<Rate> {
    if (rateCache && now() - rateCache.at < 60_000) return rateCache.value;
    const sample = 100_000;
    const p = await withTimeout(
      o.textile.preview({ chainId: CELO_CHAIN_ID, sellToken: TOKENS.USDT, buyToken: TOKENS.CNGN, buyAmount: parseUnits(String(sample), DECIMALS.CNGN) }),
      6000,
    );
    const pays = Number(formatUnits(BigInt(p.takerPays), DECIMALS.USDT));
    const fee = Number(formatUnits(BigInt(p.feeAmount || "0"), DECIMALS.USDT));
    const value = { ngnPerUsdt: sample / pays, feePer100Usdt: (fee / pays) * 100 };
    rateCache = { at: now(), value };
    return value;
  }

  async function balances(wallet: Address) {
    const read = (token: Address) =>
      withTimeout(o.reader.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }), 6000);
    const [usdt, cngn, ids, celo] = await Promise.all([
      read(TOKENS.USDT),
      read(TOKENS.CNGN),
      read(ERC8004_IDENTITY_REGISTRY).catch(() => undefined),
      // CELO pays Altana's one-time registration fee when the wallet is first activated.
      Promise.resolve()
        .then(() => withTimeout(o.reader.getBalance({ address: wallet }), 6000))
        .catch(() => undefined),
    ]);
    return {
      usdt: Number(formatUnits(usdt, DECIMALS.USDT)),
      cngn: Number(formatUnits(cngn, DECIMALS.CNGN)),
      celo: celo === undefined ? null : Number(formatUnits(celo, 18)),
      identities: ids === undefined ? null : Number(ids),
    };
  }

  async function state() {
    const ledger = loadLedger();
    const freelancers = loadFreelancers();
    const wallet = walletAddress();
    const client = loadClientRecord();
    const [live, liveRate] = await Promise.all([
      wallet ? balances(wallet).then((v) => ({ ok: true as const, ...v }), (e: Error) => ({ ok: false as const, error: e.message })) : null,
      rate().then((v) => ({ ok: true as const, ...v }), (e: Error) => ({ ok: false as const, error: e.message })),
    ]);
    let code: string | null = null;
    try {
      code = attributionCode();
    } catch {}
    const proof = storedProofInfo();
    const paid = ledger.map((e) => {
      const r = receiptOf(e);
      const f = freelancers.find((x) => x.id === e.freelancerId);
      return {
        kind: "paid" as const,
        invoiceId: e.invoiceId,
        who: f?.name ?? e.freelancerId,
        freelancerId: e.freelancerId,
        at: e.paidAt,
        amountNgn: e.amountNgn,
        usdt: r?.cost?.usdt ?? null,
        transactions: (r?.transactions ?? []).map((t) => ({ hash: t.hash, explorer: t.explorer ?? EXPLORER_TX(t.hash), tagged: Boolean(t.tagged) })),
        receipt: RECEIPT_NAME.test(basename(e.receipt)) ? basename(e.receipt) : null,
      };
    });
    const held = loadHolds().map((h) => ({
      kind: "held" as const,
      invoiceId: h.invoiceId,
      who: h.billedBy,
      at: h.heldAt,
      amountNgn: h.amountNgn,
      reasons: h.reasons,
    }));
    const weeks = Array.from({ length: 7 }, (_, i) => weekStart(now()) - (6 - i) * 7 * 86_400_000);
    return {
      agent: {
        clientName: settings.clientName() ?? null,
        attributionCode: code,
        textile: settings.textileKey() ? "key" : "keyless",
        aiReader: Boolean(settings.anthropicKey()),
        maxInvoiceUsdt: settings.maxInvoiceUsdt(),
        gasTopUpUsdt: settings.gasTopUpUsdt(),
        busy: busy ?? null,
      },
      wallet: {
        address: wallet ?? null,
        hasKey: Boolean(process.env.CLIENT_ADMIN_PRIVATE_KEY?.trim()),
        activated: Boolean(client.activatedAt),
        activatedAt: client.activatedAt ?? null,
        activationTx: client.activationTx ?? null,
        agentId: client.agentId ?? null,
        agentPage: client.agentId ? (agentPageUrl(CELO_CHAIN_ID, client.agentId) ?? null) : null,
        live,
      },
      session: sessionView(ledger),
      proof: proof && wallet && getAddress(proof.taker) === getAddress(wallet) ? { validUntil: proof.validUntil, fresh: proof.validUntil > now() } : null,
      rate: liveRate,
      freelancers: freelancers.map((f) => {
        const mine = ledger.filter((e) => e.freelancerId === f.id);
        return { ...f, paid: mine.length, totalNgn: mine.reduce((a, e) => a + e.amountNgn, 0) };
      }),
      payouts: [...paid, ...held].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 50),
      weekly: {
        starts: weeks,
        ngn: weeks.map((w) => ledger.filter((e) => Date.parse(e.paidAt) >= w && Date.parse(e.paidAt) < w + 7 * 86_400_000).reduce((a, e) => a + e.amountNgn, 0)),
      },
    };
  }

  // ---------- invoices ----------

  function inboxPath(id: string): string {
    if (!INVOICE_ID.test(id)) throw new HttpError(400, "Unknown invoice.");
    const p = join(statePath("inbox"), id);
    if (!existsSync(p)) throw new HttpError(404, "That invoice is no longer here. Upload it again.");
    return p;
  }

  async function upload(body: Record<string, unknown>) {
    const name = String(body.name ?? "invoice");
    const data = typeof body.data === "string" ? Buffer.from(body.data, "base64") : undefined;
    if (!data || data.length === 0) throw new HttpError(400, "The file is empty.");
    if (data.length > MAX_UPLOAD) throw new HttpError(400, "Invoices up to 1 MB only.");
    const ext = extname(name).toLowerCase() === ".json" ? "json" : "txt";
    const id = `${createHash("sha256").update(data).digest("hex").slice(0, 16)}.${ext}`;
    mkdirSync(statePath("inbox"), { recursive: true });
    writeFileSync(join(statePath("inbox"), id), data);
    const ledger = loadLedger();
    const anthropicKey = settings.anthropicKey();
    const review = await reviewInvoice(join(statePath("inbox"), id), {
      textile: o.textile,
      extractor: anthropicKey ? anthropicExtractor(anthropicKey, settings.anthropicModel()) : undefined,
      maxUsdt: settings.maxInvoiceUsdt(),
      gasTopUpUsdt: settings.gasTopUpUsdt(),
      weekLeft: weekLeft(ledger),
    });
    // The agent refusing on safety grounds is worth keeping; a missing key or price is not.
    const safety = review.rows.filter((r) => r.hold && !r.setup).map((r) => r.note);
    if (safety.length) {
      recordHold({
        invoiceId: review.invoice.invoiceId,
        fingerprint: review.fingerprint,
        billedBy: review.invoice.freelancer,
        amountNgn: review.invoice.amountNgn,
        reasons: safety,
        heldAt: new Date(now()).toISOString(),
      });
    }
    return {
      id,
      fileName: basename(name).slice(0, 120),
      invoice: review.invoice,
      source: review.source,
      freelancer: review.freelancer ? { id: review.freelancer.id, name: review.freelancer.name } : null,
      rows: review.rows,
      holds: review.holds,
      canOverride: review.canOverride,
      price: review.price ?? null,
    };
  }

  async function pay(id: string, body: Record<string, unknown>) {
    const path = inboxPath(id);
    const approvedUsdt = Number(body.approvedUsdt);
    if (!Number.isFinite(approvedUsdt) || approvedUsdt <= 0) throw new HttpError(400, "Approve a price first.");
    const outcome = await exclusive("paying an invoice", () => actions.pay(path, { approvedUsdt, approveHolds: body.approveHolds === true }));
    switch (outcome.status) {
      case "held":
        return { status: "held", holds: outcome.holds };
      case "planned":
        return { status: "planned" };
      case "failed":
        return { status: "failed", transactions: outcome.hashes.map((h) => ({ hash: h, explorer: EXPLORER_TX(h) })) };
      case "paid":
        return {
          status: "paid",
          invoiceId: outcome.plan.invoice.invoiceId,
          amountNgn: outcome.plan.invoice.amountNgn,
          freelancer: outcome.plan.freelancer.name,
          usdt: outcome.plan.usdtCost,
          payoutAddress: outcome.plan.payout.stealthAddress,
          transactions: outcome.tags.map((t) => ({ hash: t.hash, explorer: EXPLORER_TX(t.hash), tagged: t.tagged })),
          receipt: basename(outcome.receiptPath),
        };
    }
  }

  function receiptFile(name: string): string {
    if (!RECEIPT_NAME.test(name)) throw new HttpError(400, "Unknown receipt.");
    const p = join(receiptsDir(), name);
    if (!existsSync(p)) throw new HttpError(404, "Receipt not found.");
    return readFileSync(p, "utf8");
  }

  // ---------- freelancers ----------

  function addFreelancer(body: Record<string, unknown>) {
    const name = String(body.name ?? "").trim();
    const metaAddress = String(body.metaAddress ?? "").trim();
    if (!name) throw new HttpError(400, "Add their name.");
    if (!metaAddress) throw new HttpError(400, "Paste the receiving code they sent you.");
    try {
      parseMetaAddress(metaAddress);
    } catch (e) {
      throw new HttpError(400, `That receiving code doesn't look right: ${(e as Error).message}`);
    }
    const list = loadFreelancers();
    if (list.some((f) => f.metaAddress.toLowerCase() === metaAddress.toLowerCase())) {
      throw new HttpError(400, "Someone on your list already has this receiving code.");
    }
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "freelancer";
    let id = base;
    for (let i = 2; list.some((f) => f.id === id); i++) id = `${base}-${i}`;
    const entry: Freelancer = {
      id,
      name,
      metaAddress,
      ...(String(body.role ?? "").trim() ? { role: String(body.role).trim().slice(0, 60) } : {}),
      ...(numberOf(body.maxInvoiceNgn) ? { maxInvoiceNgn: numberOf(body.maxInvoiceNgn) } : {}),
      ...(numberOf(body.agreedNgn) ? { agreedNgn: numberOf(body.agreedNgn) } : {}),
      ...(aliasesOf(body.aliases).length ? { aliases: aliasesOf(body.aliases) } : {}),
    };
    saveFreelancers([...list, entry]);
    return { id };
  }

  function removeFreelancer(id: string) {
    const list = loadFreelancers();
    if (!list.some((f) => f.id === id)) throw new HttpError(404, "Not on your list.");
    saveFreelancers(list.filter((f) => f.id !== id));
    return { removed: id };
  }

  // ---------- routing ----------

  async function api(req: IncomingMessage, url: URL): Promise<Json> {
    const [what, id, sub, ...extra] = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
    const m = req.method ?? "GET";
    const body = m === "POST" ? await readBody(req) : {};
    const is = (method: string, w: string, withId: boolean, s?: string) =>
      m === method && what === w && Boolean(id) === withId && sub === s && extra.length === 0;

    if (is("GET", "state", false)) return state();
    if (is("POST", "invoices", false)) return upload(body);
    if (is("POST", "invoices", true, "pay")) return pay(id!, body);
    if (is("POST", "freelancers", false)) return addFreelancer(body);
    if (is("DELETE", "freelancers", true)) return removeFreelancer(id!);
    if (is("GET", "receipts", true)) return JSON.parse(receiptFile(id!)) as Json;
    if (is("POST", "wallet", true, undefined) && id === "setup") {
      await exclusive("activating your wallet", actions.walletSetup);
      return { ok: true };
    }
    if (is("POST", "session", true, undefined) && id === "grant") {
      const limits = { usdtPerWeek: numberOf(body.usdtPerWeek), cngnPerWeek: numberOf(body.cngnPerWeek), days: numberOf(body.days) };
      if (!limits.usdtPerWeek || !limits.cngnPerWeek || !limits.days) throw new HttpError(400, "Fill in all three limits.");
      if (limits.days > 90) throw new HttpError(400, "A key can last 90 days at most.");
      await exclusive("giving the agent a key", () => actions.grant(limits));
      return { ok: true };
    }
    if (is("POST", "session", true, undefined) && id === "revoke") {
      await exclusive("taking the agent's key back", actions.revoke);
      return { ok: true };
    }
    if (is("POST", "proof", true, undefined) && id === "refresh") {
      await exclusive("signing the Textile proof", actions.proofRefresh);
      return { ok: true };
    }
    throw new HttpError(404, "No such action.");
  }

  function serveStatic(url: URL, res: ServerResponse) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = resolve(webDir, `.${rel}`);
    if (!file.startsWith(webDir + sep) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "Not found.");
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    let content: Buffer | string = readFileSync(file);
    if (rel === "/index.html") {
      let code: string | null = null;
      try {
        code = attributionCode();
      } catch {}
      const cfg = JSON.stringify({ agent: true, token: o.token, attributionCode: code, rpcUrl: settings.rpcUrl() }).replace(/</g, "\\u003c");
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
      const out = await api(req, url);
      send(res, 200, out, rpcOrigin);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400;
      send(res, status, { error: (e as Error).message || String(e) }, rpcOrigin);
    }
  };
}

// ---------- the real actions ----------

function defaultActions(o: WebOptions): Actions {
  const adminKey = () => privateKey("CLIENT_ADMIN_PRIVATE_KEY", "Add your wallet key to .env first: npm run reach -- wallet new-key");
  return {
    walletSetup: async () => {
      const { result } = await activateClientWallet(adminKey());
      if (result.status !== "CONFIRMED") throw new Error(`The wallet's first transaction is ${result.status.toLowerCase()}. Try again in a minute.`);
    },
    grant: (limits) => grantAgentSession(adminKey(), { ...limits, announcer: settings.announcer() }),
    revoke: () => revokeAgentSession(adminKey()),
    proofRefresh: () => refreshTakerProof(adminKey()),
    pay: (invoicePath, opts) => {
      const code = attributionCode();
      const anthropicKey = settings.anthropicKey();
      return payInvoice(invoicePath, {
        executor: new AltanaExecutor(loadAgentSession(), code),
        textile: o.textile,
        textileKeyless: !settings.textileKey(),
        reader: o.reader,
        code,
        maxUsdt: settings.maxInvoiceUsdt(),
        gasTopUpUsdt: settings.gasTopUpUsdt(),
        announcer: settings.announcer(),
        extractor: anthropicKey ? anthropicExtractor(anthropicKey, settings.anthropicModel()) : undefined,
        approveHolds: opts.approveHolds,
        approvedUsdt: opts.approvedUsdt,
      });
    },
  };
}

// ---------- small helpers ----------

type Rate = { ngnPerUsdt: number; feePer100Usdt: number };
type Receipt = {
  cost?: { usdt?: number };
  payout?: { gasMoneyUsdt?: number };
  transactions?: { hash: Hex; explorer?: string; tagged?: boolean }[];
};

function describeCall(c: { to?: Address; signature?: string }) {
  const to = c.to ? getAddress(c.to) : undefined;
  const sig = c.signature ?? "any function";
  if (to === TOKENS.USDT && sig.startsWith("approve")) return { what: "Approve USD₮ for the swap", detail: `USD₮ · ${sig}` };
  if (to === TOKENS.USDT && sig.startsWith("transfer")) return { what: "Send gas money with each payout", detail: `USD₮ · ${sig}` };
  if (to === TOKENS.CNGN) return { what: "Send cNGN to the freelancer", detail: `cNGN · ${sig}` };
  if (to === TEXTILE_REACTOR) return { what: "Swap on Textile FX", detail: `LimitOrderReactor · ${to.slice(0, 6)}…${to.slice(-4)}` };
  if (sig.startsWith("announce")) return { what: "Announce the private payout", detail: `Announcer · ${sig}` };
  return { what: "Other call", detail: `${to ?? "any contract"} · ${sig}` };
}

function numberOf(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[,\s₦]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function aliasesOf(v: unknown): string[] {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("No answer in time.")), ms))]);
}

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
    if (size > MAX_UPLOAD * 2) throw new HttpError(413, "Too large.");
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
