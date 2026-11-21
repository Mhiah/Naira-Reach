// The agent the website talks to, shared by both places it runs:
//  - on the client's computer, behind the local server (src/web.ts)
//  - in the client's own browser, on the online site (src/browser/send.ts)
// It holds no keys itself: `env.adminKey()` hands over the client's key only for
// the moment an action needs it. Records go through the active store.
import { agentPageUrl } from "@altananetwork/sdk";
import { erc20Abi, formatUnits, getAddress, parseUnits, sha256, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activateClientWallet, grantAgentSession, loadAgentSession, loadClientRecord, refreshTakerProof, revokeAgentSession, storedSession } from "./altana.ts";
import { CELO_CHAIN_ID, DECIMALS, ERC8004_IDENTITY_REGISTRY, EXPLORER_TX, TEXTILE_REACTOR, TOKENS } from "./celo.ts";
import { loadFreelancers, loadHolds, loadLedger, recordHold, saveFreelancers, type Freelancer, type PaidEntry } from "./checks.ts";
import { AltanaExecutor } from "./executor.ts";
import type { Invoice, InvoiceFile } from "./invoice.ts";
import { payInvoice, reviewInvoice, type PayOutcome } from "./pay.ts";
import { storedProofInfo } from "./proof.ts";
import { parseMetaAddress } from "./stealth.ts";
import { receiptName, store } from "./store.ts";
import type { TextileClient } from "./textile.ts";

export class AgentError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Everything that signs with the client's key or moves money. Tests replace these. */
export type Actions = {
  walletSetup: () => Promise<unknown>;
  grant: (limits: { usdtPerWeek: number; cngnPerWeek: number; days: number }) => Promise<unknown>;
  revoke: () => Promise<unknown>;
  proofRefresh: () => Promise<unknown>;
  pay: (invoice: InvoiceFile, opts: { approvedUsdt: number; approveHolds: boolean }) => Promise<PayOutcome>;
};

export type AgentEnv = {
  textile: TextileClient;
  /** No Textile partner key: quotes are proven with the wallet's own signature. */
  textileKeyless: boolean;
  reader: PublicClient;
  /** The client's wallet key, for the one action that needs it. Throws if it isn't available. */
  adminKey: () => Hex;
  hasAdminKey: () => boolean;
  attributionCode: () => string | null;
  clientName?: () => string | null;
  maxInvoiceUsdt: number;
  gasTopUpUsdt: number;
  announcer?: Address;
  extractor?: (redactedText: string) => Promise<Invoice>;
  actions?: Partial<Actions>;
  now?: () => number;
};

export type Json = Record<string, unknown> | unknown[];

const INVOICE_ID = /^[a-f0-9]{16}\.(json|txt)$/;
const RECEIPT_FILE = /^[A-Za-z0-9_-]+-\d+\.json$/;
const MAX_UPLOAD = 1024 * 1024;

type Rate = { ngnPerUsdt: number; feePer100Usdt: number };
type Receipt = {
  cost?: { usdt?: number };
  payout?: { gasMoneyUsdt?: number };
  transactions?: { hash: Hex; explorer?: string; tagged?: boolean }[];
};

export function createAgent(env: AgentEnv) {
  const now = env.now ?? (() => Date.now());
  const actions: Actions = { ...defaultActions(env), ...env.actions };
  let busy: string | undefined;
  let rateCache: { at: number; value: Rate } | undefined;

  async function exclusive<T>(what: string, fn: () => Promise<T>): Promise<T> {
    if (busy) throw new AgentError(409, `Still busy with: ${busy}. Wait for it to finish.`);
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
      return store().read<Receipt | undefined>(receiptName(entry.receipt), undefined);
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
    if (!env.hasAdminKey()) return undefined;
    try {
      return privateKeyToAccount(env.adminKey()).address;
    } catch {
      return undefined;
    }
  }

  async function rate(): Promise<Rate> {
    if (rateCache && now() - rateCache.at < 60_000) return rateCache.value;
    const sample = 100_000;
    const p = await withTimeout(
      env.textile.preview({ chainId: CELO_CHAIN_ID, sellToken: TOKENS.USDT, buyToken: TOKENS.CNGN, buyAmount: parseUnits(String(sample), DECIMALS.CNGN) }),
      8000,
    );
    const pays = Number(formatUnits(BigInt(p.takerPays), DECIMALS.USDT));
    const fee = Number(formatUnits(BigInt(p.feeAmount || "0"), DECIMALS.USDT));
    const value = { ngnPerUsdt: sample / pays, feePer100Usdt: (fee / pays) * 100 };
    rateCache = { at: now(), value };
    return value;
  }

  async function balances(wallet: Address) {
    const read = (token: Address) =>
      withTimeout(env.reader.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }), 8000);
    const [usdt, cngn, ids, celo] = await Promise.all([
      read(TOKENS.USDT),
      read(TOKENS.CNGN),
      read(ERC8004_IDENTITY_REGISTRY).catch(() => undefined),
      // CELO pays Altana's one-time registration fees (the wallet, and each agent key).
      Promise.resolve()
        .then(() => withTimeout(env.reader.getBalance({ address: wallet }), 8000))
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
    const proof = storedProofInfo();
    const paid = ledger.map((e) => {
      const r = receiptOf(e);
      const f = freelancers.find((x) => x.id === e.freelancerId);
      const file = receiptName(e.receipt).slice("receipts/".length);
      return {
        kind: "paid" as const,
        invoiceId: e.invoiceId,
        who: f?.name ?? e.freelancerId,
        freelancerId: e.freelancerId,
        at: e.paidAt,
        amountNgn: e.amountNgn,
        usdt: r?.cost?.usdt ?? null,
        transactions: (r?.transactions ?? []).map((t) => ({ hash: t.hash, explorer: t.explorer ?? EXPLORER_TX(t.hash), tagged: Boolean(t.tagged) })),
        receipt: RECEIPT_FILE.test(file) ? file : null,
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
        clientName: env.clientName?.() ?? null,
        attributionCode: env.attributionCode(),
        textile: env.textileKeyless ? "keyless" : "key",
        aiReader: Boolean(env.extractor),
        maxInvoiceUsdt: env.maxInvoiceUsdt,
        gasTopUpUsdt: env.gasTopUpUsdt,
        busy: busy ?? null,
      },
      wallet: {
        address: wallet ?? null,
        hasKey: env.hasAdminKey(),
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

  function inboxFile(id: string): InvoiceFile {
    if (!INVOICE_ID.test(id)) throw new AgentError(400, "Unknown invoice.");
    const saved = store().read<{ name: string; data: string } | null>(`inbox/${id}`, null);
    if (!saved) throw new AgentError(404, "That invoice is no longer here. Upload it again.");
    return { name: saved.name, bytes: fromBase64(saved.data) };
  }

  async function upload(body: Record<string, unknown>) {
    const name = String(body.name ?? "invoice").split(/[\\/]/).pop()!.slice(0, 120);
    const data = typeof body.data === "string" ? body.data : "";
    const bytes = data ? fromBase64(data) : new Uint8Array();
    if (bytes.length === 0) throw new AgentError(400, "The file is empty.");
    if (bytes.length > MAX_UPLOAD) throw new AgentError(400, "Invoices up to 1 MB only.");
    const ext = name.toLowerCase().endsWith(".json") ? "json" : "txt";
    const id = `${sha256(bytes).slice(2, 18)}.${ext}`;
    store().write(`inbox/${id}`, { name: `invoice.${ext}`, data });
    const review = await reviewInvoice(
      { name: `invoice.${ext}`, bytes },
      {
        textile: env.textile,
        extractor: env.extractor,
        maxUsdt: env.maxInvoiceUsdt,
        gasTopUpUsdt: env.gasTopUpUsdt,
        weekLeft: weekLeft(loadLedger()),
      },
    );
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
      fileName: name,
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
    const file = inboxFile(id);
    const approvedUsdt = Number(body.approvedUsdt);
    if (!Number.isFinite(approvedUsdt) || approvedUsdt <= 0) throw new AgentError(400, "Approve a price first.");
    const outcome = await exclusive("paying an invoice", () => actions.pay(file, { approvedUsdt, approveHolds: body.approveHolds === true }));
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
          receipt: receiptName(outcome.receiptPath).slice("receipts/".length),
        };
    }
  }

  function receipt(file: string): Json {
    if (!RECEIPT_FILE.test(file)) throw new AgentError(400, "Unknown receipt.");
    const r = store().read<Json | null>(`receipts/${file}`, null);
    if (!r) throw new AgentError(404, "Receipt not found.");
    return r;
  }

  // ---------- freelancers ----------

  function addFreelancer(body: Record<string, unknown>) {
    const name = String(body.name ?? "").trim();
    const metaAddress = String(body.metaAddress ?? "").trim();
    if (!name) throw new AgentError(400, "Add their name.");
    if (!metaAddress) throw new AgentError(400, "Paste the receiving code they sent you.");
    try {
      parseMetaAddress(metaAddress);
    } catch (e) {
      throw new AgentError(400, `That receiving code doesn't look right: ${(e as Error).message}`);
    }
    const list = loadFreelancers();
    if (list.some((f) => f.metaAddress.toLowerCase() === metaAddress.toLowerCase())) {
      throw new AgentError(400, "Someone on your list already has this receiving code.");
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
    if (!list.some((f) => f.id === id)) throw new AgentError(404, "Not on your list.");
    saveFreelancers(list.filter((f) => f.id !== id));
    return { removed: id };
  }

  // ---------- one entry point for both places the agent runs ----------

  /** Answer a Send-side request. `path` is what follows /api, e.g. "/invoices/<id>/pay". */
  async function dispatch(method: string, path: string, body: Record<string, unknown> = {}): Promise<Json> {
    const [what, id, sub, ...extra] = path.split("/").filter(Boolean).map(decodeURIComponent);
    const is = (m: string, w: string, withId: boolean, s?: string) => method === m && what === w && Boolean(id) === withId && sub === s && extra.length === 0;

    if (is("GET", "state", false)) return state();
    if (is("POST", "invoices", false)) return upload(body);
    if (is("POST", "invoices", true, "pay")) return pay(id!, body);
    if (is("POST", "freelancers", false)) return addFreelancer(body);
    if (is("DELETE", "freelancers", true)) return removeFreelancer(id!);
    if (is("GET", "receipts", true)) return receipt(id!);
    if (is("POST", "wallet", true) && id === "setup") {
      await exclusive("activating your wallet", actions.walletSetup);
      return { ok: true };
    }
    if (is("POST", "session", true) && id === "grant") {
      const limits = { usdtPerWeek: numberOf(body.usdtPerWeek), cngnPerWeek: numberOf(body.cngnPerWeek), days: numberOf(body.days) };
      if (!limits.usdtPerWeek || !limits.cngnPerWeek || !limits.days) throw new AgentError(400, "Fill in all three limits.");
      if (limits.days > 90) throw new AgentError(400, "A key can last 90 days at most.");
      await exclusive("giving the agent a key", () => actions.grant(limits));
      return { ok: true };
    }
    if (is("POST", "session", true) && id === "revoke") {
      await exclusive("taking the agent's key back", actions.revoke);
      return { ok: true };
    }
    if (is("POST", "proof", true) && id === "refresh") {
      await exclusive("signing the Textile proof", actions.proofRefresh);
      return { ok: true };
    }
    throw new AgentError(404, "No such action.");
  }

  return { dispatch, state };
}

// ---------- the real actions ----------

function defaultActions(env: AgentEnv): Actions {
  const code = () => {
    const c = env.attributionCode();
    if (!c) throw new AgentError(400, "Add your attribution code first.");
    return c;
  };
  return {
    walletSetup: async () => {
      const { result } = await activateClientWallet(env.adminKey());
      if (result.status !== "CONFIRMED") throw new Error(`The wallet's first transaction is ${result.status.toLowerCase()}. Try again in a minute.`);
    },
    grant: (limits) => grantAgentSession(env.adminKey(), { ...limits, announcer: env.announcer }),
    revoke: () => revokeAgentSession(env.adminKey()),
    proofRefresh: () => refreshTakerProof(env.adminKey()),
    pay: async (invoice, opts) => {
      // Textile's wallet proof lasts about 11 hours. With the client's key at hand, renew it rather than fail.
      const proof = storedProofInfo();
      if (env.textileKeyless && env.hasAdminKey() && (!proof || proof.validUntil <= Date.now())) await refreshTakerProof(env.adminKey());
      return payInvoice(invoice, {
        executor: new AltanaExecutor(loadAgentSession(), code()),
        textile: env.textile,
        textileKeyless: env.textileKeyless,
        reader: env.reader,
        code: code(),
        maxUsdt: env.maxInvoiceUsdt,
        gasTopUpUsdt: env.gasTopUpUsdt,
        announcer: env.announcer,
        extractor: env.extractor,
        approveHolds: opts.approveHolds,
        approvedUsdt: opts.approvedUsdt,
      });
    },
  };
}

// ---------- small helpers ----------

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

export function numberOf(v: unknown): number {
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

export function fromBase64(b64: string): Uint8Array {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    throw new AgentError(400, "Couldn't read that file.");
  }
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

