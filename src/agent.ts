// The agent the website talks to, shared by both places it runs:
//  - on the client's computer, behind the local server (src/web.ts)
//  - in the client's own browser, on the online site (src/browser/send.ts)
// It holds no keys itself: `env.adminKey()` hands over the client's key only for
// the moment an action needs it. Records go through the active store.
import { agentPageUrl, getKey, keyHashForSessionOrKey } from "@altananetwork/sdk";
import { BaseError, ContractFunctionRevertedError, erc20Abi, formatUnits, getAddress, parseUnits, sha256, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activateClientWallet, grantAgentSession, loadAgentSession, loadClientRecord, refreshTakerProof, revokeAgentSession, sessionMayAnnounce, storedSession, walletExecute } from "./altana.ts";
import { announceCall, announcerLive, deployCall, ERC5564_ANNOUNCER } from "./announcer.ts";
import { CELO_CHAIN_ID, DECIMALS, ERC8004_IDENTITY_REGISTRY, EXPLORER_TX, TEXTILE_REACTOR, TOKENS } from "./celo.ts";
import { loadFreelancers, loadHolds, loadLedger, recordHold, saveFreelancers, type Freelancer, type PaidEntry } from "./checks.ts";
import { AltanaExecutor, type Call } from "./executor.ts";
import { MAX_INVOICE_NGN, type Invoice, type InvoiceFile } from "./invoice.ts";
import { payInvoice, reviewInvoice, type PayOutcome } from "./pay.ts";
import { storedProofInfo } from "./proof.ts";
import { checkDestination, parseAmount, withdraw, type WithdrawToken } from "./withdraw.ts";
import { currentAgentUri, registrationUri, updateAgentProfile } from "./identity.ts";
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
  pay: (invoice: InvoiceFile, opts: { approvedUsdt: number; approveHolds: boolean; announce: boolean }) => Promise<PayOutcome>;
  /** A one-off action from the client's own wallet. `tag: false` for the announcer's deployment. */
  walletCalls: (calls: Call[], opts: { tag: boolean }) => Promise<{ status: string; hash?: Hex }>;
  /** Send USD₮ or CELO out of the client's own wallet, signed with the client's key. */
  withdraw: (w: { token: WithdrawToken; to: string; amount: string }) => Promise<{ token: WithdrawToken; amount: string; to: Address; hash: Hex }>;
  /** Replace the placeholder ERC-8004 profile with Naira Reach's, from the client's own wallet. */
  updateProfile: (agentId: string) => Promise<{ status: "updated" | "unchanged"; hash?: Hex; agentId: string }>;
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
  /**
   * The Celo RPC the wallet sends from. With it and the wallet's key, payments and
   * wallet calls are sent by the wallet itself, tagged, instead of Altana's relayer.
   */
  rpcUrl?: string;
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
  invoice?: { amountNgn?: number };
  cost?: { usdt?: number };
  payout?: {
    gasMoneyUsdt?: number;
    stealthAddress?: Address;
    ephemeralPublicKey?: Hex;
    viewTag?: Hex;
    cngn?: number;
    announced?: { by: "agent" | "wallet"; hash: Hex | null };
  };
  transactions?: { hash: Hex; explorer?: string; tagged?: boolean }[];
};

export function createAgent(env: AgentEnv) {
  const now = env.now ?? (() => Date.now());
  const actions: Actions = { ...defaultActions(env), ...env.actions };
  let busy: string | undefined;
  let rateCache: { at: number; value: Rate } | undefined;
  let liveCache: { at: number; live: boolean } | undefined;

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

  // Is the agent's key still on the wallet? Checked on Celo, at most once a minute.
  // false only when the wallet answers that it has no such key (replaced or revoked); null when unsure.
  let keyCheck: { hash: Hex; at: number; onChain: boolean | null } | null = null;
  async function keyOnChain(): Promise<boolean | null> {
    const s = storedSession();
    if (!s) return null;
    let hash: Hex;
    try {
      hash = keyHashForSessionOrKey(s.publicKey);
    } catch {
      return null;
    }
    if (keyCheck && keyCheck.hash === hash && now() - keyCheck.at < 60_000) return keyCheck.onChain;
    let onChain: boolean | null;
    try {
      await withTimeout(getKey(env.reader, s.walletAddress, hash), 8000);
      onChain = true;
    } catch (e) {
      onChain = e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) ? false : null;
    }
    keyCheck = { hash, at: now(), onChain };
    return onChain;
  }

  function sessionView(ledger: PaidEntry[], onChain: boolean | null = null) {
    const s = storedSession();
    if (!s) return null;
    const spend = (token: Address) => s.permissions.spend?.find((x) => x.token && getAddress(x.token) === getAddress(token));
    const usdtLimit = spend(TOKENS.USDT);
    const cngnLimit = spend(TOKENS.CNGN);
    const used = usedThisWeek(ledger);
    const ranOut = s.expiry * 1000 <= now();
    const gone = !ranOut && onChain === false;
    return {
      expiresAt: s.expiry * 1000,
      // A key no longer on the wallet can't pay, whatever its expiry says.
      expired: ranOut || gone,
      gone,
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

  async function rate(): Promise<Rate & { asOf: number }> {
    if (rateCache && now() - rateCache.at < 60_000) return { ...rateCache.value, asOf: rateCache.at };
    const sample = 100_000;
    const ask = () =>
      withTimeout(
        env.textile.preview({ chainId: CELO_CHAIN_ID, sellToken: TOKENS.USDT, buyToken: TOKENS.CNGN, buyAmount: parseUnits(String(sample), DECIMALS.CNGN) }),
        15_000,
      );
    try {
      // Textile (and the site's proxy, from cold) can be slow: one more try before giving up.
      const p = await ask().catch(ask);
      const pays = Number(formatUnits(BigInt(p.takerPays), DECIMALS.USDT));
      const fee = Number(formatUnits(BigInt(p.feeAmount || "0"), DECIMALS.USDT));
      rateCache = { at: now(), value: { ngnPerUsdt: sample / pays, feePer100Usdt: (fee / pays) * 100 } };
      return { ...rateCache.value, asOf: rateCache.at };
    } catch (e) {
      // A price from the last 30 minutes beats no price; the screen says how old it is.
      if (rateCache && now() - rateCache.at < 30 * 60_000) return { ...rateCache.value, asOf: rateCache.at };
      throw e;
    }
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

  // ---------- private delivery (ERC-5564 announcements) ----------

  async function announcerIsLive(): Promise<boolean> {
    if (liveCache && (liveCache.live || now() - liveCache.at < 60_000)) return liveCache.live;
    const live = await withTimeout(announcerLive(env.reader), 8000).catch(() => false);
    liveCache = { at: now(), live };
    return live;
  }

  /** Paid payouts not yet announced, so their freelancer can't find them without a receipt. */
  function unannounced() {
    return loadLedger()
      .map((e) => ({ name: receiptName(e.receipt), r: receiptOf(e) }))
      .filter((x): x is { name: string; r: Receipt } => {
        const p = x.r?.payout;
        return Boolean(p?.stealthAddress && p.ephemeralPublicKey && p.viewTag && !p.announced);
      });
  }

  async function announcePending(): Promise<{ announced: number; hash: Hex | null }> {
    const pending = unannounced();
    if (!pending.length) return { announced: 0, hash: null };
    if (!(await announcerIsLive())) throw new AgentError(400, "Turn on automatic delivery first.");
    const calls = pending.map(({ r }) =>
      announceCall(
        { stealthAddress: r.payout!.stealthAddress!, ephemeralPublicKey: r.payout!.ephemeralPublicKey!, viewTag: r.payout!.viewTag! },
        parseUnits(String(r.payout!.cngn ?? r.invoice?.amountNgn ?? 0), DECIMALS.CNGN),
      ),
    );
    const out = await actions.walletCalls(calls, { tag: true });
    if (out.status !== "CONFIRMED") throw new Error(`The announcement is ${out.status.toLowerCase()}. Try again in a minute.`);
    for (const { name, r } of pending) store().write(name, { ...r, payout: { ...r.payout, announced: { by: "wallet", hash: out.hash ?? null } } });
    return { announced: pending.length, hash: out.hash ?? null };
  }

  /** One time for everyone: put the standard announcer on Celo, then announce what was paid before. */
  async function setupDelivery() {
    if (!(await announcerIsLive())) {
      const out = await actions.walletCalls([deployCall()], { tag: false });
      if (out.status !== "CONFIRMED") throw new Error(`Adding the announcer is ${out.status.toLowerCase()}. Try again in a minute.`);
      liveCache = undefined;
      if (!(await announcerIsLive())) throw new Error("The announcer didn't appear on Celo. Try again.");
    }
    return announcePending();
  }

  // Whether the ERC-8004 profile is still Altana's placeholder. Read at most once a minute.
  let profileCache: { at: number; agentId: string; value: "current" | "placeholder" } | null = null;
  async function profileState(agentId: string | undefined): Promise<"current" | "placeholder" | null> {
    if (!agentId) return null;
    if (profileCache && profileCache.agentId === agentId && now() - profileCache.at < 60_000) return profileCache.value;
    try {
      const uri = await withTimeout(currentAgentUri(env.reader, agentId), 8000);
      const value = uri === registrationUri(agentId) ? "current" : "placeholder";
      profileCache = { at: now(), agentId, value };
      return value;
    } catch {
      return null; // Celo unreachable: say nothing rather than guess.
    }
  }

  async function state() {
    const ledger = loadLedger();
    const freelancers = loadFreelancers();
    const wallet = walletAddress();
    const client = loadClientRecord();
    const [live, liveRate, announcer, onChain, profile] = await Promise.all([
      wallet ? balances(wallet).then((v) => ({ ok: true as const, ...v }), (e: Error) => ({ ok: false as const, error: e.message })) : null,
      rate().then((v) => ({ ok: true as const, ...v }), (e: Error) => ({ ok: false as const, error: e.message })),
      announcerIsLive(),
      keyOnChain(),
      profileState(client.agentId),
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
        profile,
        live,
      },
      session: sessionView(ledger, onChain),
      delivery: { live: announcer, address: ERC5564_ANNOUNCER, pending: unannounced().length, agentAnnounces: sessionMayAnnounce() },
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
    if ((await keyOnChain()) === false) throw new AgentError(400, KEY_GONE);
    const file = inboxFile(id);
    const approvedUsdt = Number(body.approvedUsdt);
    if (!Number.isFinite(approvedUsdt) || approvedUsdt <= 0) throw new AgentError(400, "Approve a price first.");
    const delivery = await announcerIsLive();
    const agentAnnounces = sessionMayAnnounce() && delivery;
    let deliveryError: string | null = null;
    const outcome = await exclusive("paying an invoice", async () => {
      const out = await actions.pay(file, { approvedUsdt, approveHolds: body.approveHolds === true, announce: agentAnnounces }).catch((e: unknown) => {
        if (e instanceof Error) e.message = friendlyPayError(e.message);
        throw e;
      });
      // The agent's key couldn't announce it: the client's wallet does, so the freelancer still finds it.
      if (out.status === "paid" && !agentAnnounces && env.hasAdminKey() && delivery) {
        await announcePending().catch((e: Error) => {
          deliveryError = e.message;
        });
      }
      return out;
    });
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
          delivered: Boolean(store().read<Receipt | null>(receiptName(outcome.receiptPath), null)?.payout?.announced),
          // Not delivered by itself: the page offers to deliver it straight away.
          canDeliver: delivery && env.hasAdminKey(),
          deliveryError,
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
    const limitNgn = formNumber(body.maxInvoiceNgn, "Limit per invoice", { max: MAX_INVOICE_NGN, decimals: 2 });
    const agreedNgn = formNumber(body.agreedNgn, "Fixed amount", { max: MAX_INVOICE_NGN, decimals: 2 });
    const entry: Freelancer = {
      id,
      name,
      metaAddress,
      ...(String(body.role ?? "").trim() ? { role: String(body.role).trim().slice(0, 60) } : {}),
      ...(limitNgn !== undefined ? { maxInvoiceNgn: limitNgn } : {}),
      ...(agreedNgn !== undefined ? { agreedNgn } : {}),
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
      const usdtPerWeek = formNumber(body.usdtPerWeek, "USD₮ per week", { max: 1_000_000, decimals: 6 });
      const cngnPerWeek = formNumber(body.cngnPerWeek, "Naira per week", { max: MAX_INVOICE_NGN, decimals: 2 });
      const days = formNumber(body.days, "Days", { max: 1_000, decimals: 0 });
      if (!usdtPerWeek || !cngnPerWeek || !days) throw new AgentError(400, "Fill in all three limits.");
      if (days > 90) throw new AgentError(400, "A key can last 90 days at most.");
      const limits = { usdtPerWeek, cngnPerWeek, days };
      await exclusive("giving the agent a key", () => actions.grant(limits));
      return { ok: true };
    }
    if (is("POST", "session", true) && id === "revoke") {
      await exclusive("taking the agent's key back", actions.revoke);
      return { ok: true };
    }
    if (is("POST", "wallet", true) && id === "withdraw") {
      // The client's own money, signed with the client's own key: never the agent's.
      if (!env.hasAdminKey() || !env.rpcUrl) throw new AgentError(400, "Withdrawing needs your wallet key here.");
      const token = body.token === "CELO" ? "CELO" : body.token === "USDT" ? "USDT" : null;
      if (!token) throw new AgentError(400, "Choose USD₮ or CELO.");
      const to = String(body.to ?? "");
      const amount = String(body.amount ?? "");
      try {
        checkDestination(to, privateKeyToAccount(env.adminKey()).address);
        if (amount.trim().toLowerCase() !== "max") parseAmount(amount, token);
      } catch (e) {
        throw new AgentError(400, (e as Error).message);
      }
      return exclusive("withdrawing from your wallet", () => actions.withdraw({ token, to, amount }));
    }
    if (is("POST", "wallet", true) && id === "profile") {
      // Signed with the client's own key: the registry lets only the identity's owner change it.
      if (!env.hasAdminKey() || !env.rpcUrl) throw new AgentError(400, "Updating the profile needs your wallet key here.");
      const agentId = loadClientRecord().agentId;
      if (!agentId) throw new AgentError(400, "This wallet has no ERC-8004 identity yet. It's registered when the wallet is activated.");
      const r = await exclusive("updating your agent's public profile", () => actions.updateProfile(agentId));
      profileCache = null;
      return r;
    }
    if (is("POST", "delivery", true) && id === "setup") {
      return exclusive("turning on automatic delivery", setupDelivery);
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
  // The wallet sends its own transactions when its key is here (see selfsubmit.ts).
  const selfSubmit = () => Boolean(env.rpcUrl) && env.hasAdminKey();
  return {
    walletSetup: async () => {
      const { result } = await activateClientWallet(env.adminKey());
      if (result.status !== "CONFIRMED") throw new Error(`The wallet's first transaction is ${result.status.toLowerCase()}. Try again in a minute.`);
    },
    grant: (limits) => grantAgentSession(env.adminKey(), { ...limits, announcer: env.announcer }),
    revoke: () => revokeAgentSession(env.adminKey()),
    proofRefresh: () => refreshTakerProof(env.adminKey()),
    withdraw: (w) => withdraw({ adminKey: env.adminKey(), rpcUrl: env.rpcUrl!, code: code(), ...w }),
    updateProfile: (agentId) => updateAgentProfile({ adminKey: env.adminKey(), rpcUrl: env.rpcUrl!, agentId, code: code(), reader: env.reader }),
    walletCalls: (calls, opts) => walletExecute(env.adminKey(), calls, opts.tag ? code() : null, selfSubmit() ? { rpcUrl: env.rpcUrl!, code: code() } : undefined),
    pay: async (invoice, opts) => {
      // Textile's wallet proof lasts about 11 hours. With the client's key at hand, renew it rather than fail.
      const proof = storedProofInfo();
      if (env.textileKeyless && env.hasAdminKey() && (!proof || proof.validUntil <= Date.now())) await refreshTakerProof(env.adminKey());
      return payInvoice(invoice, {
        executor: new AltanaExecutor(loadAgentSession(), code(), selfSubmit() ? { adminKey: env.adminKey(), rpcUrl: env.rpcUrl! } : undefined),
        textile: env.textile,
        textileKeyless: env.textileKeyless,
        reader: env.reader,
        code: code(),
        maxUsdt: env.maxInvoiceUsdt,
        gasTopUpUsdt: env.gasTopUpUsdt,
        announcer: opts.announce ? (env.announcer ?? ERC5564_ANNOUNCER) : undefined,
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

/** What the agent's key being gone means, in words the client can act on. */
export const KEY_GONE =
  "The agent's key is no longer on your wallet: it was replaced or revoked, so nothing was sent. Pay from the browser where you gave the agent its current key, or give it a new key on Agent access.";

/** Turn the raw failures a client can actually hit while paying into plain sentences. */
export function friendlyPayError(message: string): string {
  if (/key hash 0x[0-9a-f]+ is unknown/i.test(message)) return KEY_GONE;
  if (/No firm quote \(no_quote/i.test(message)) {
    return "Textile's market makers didn't lock in a price just now, so nothing was sent. Wait a minute, then press Approve and pay again.";
  }
  if (/No firm quote \(/i.test(message)) return `Textile didn't give a firm price, so nothing was sent. Try again in a minute. (${message.replace(/^No firm quote /, "").replace(/\.$/, "")})`;
  return message;
}

export function numberOf(v: unknown): number {
  const t = String(v ?? "").replace(/[,\s₦]/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return 0;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A number typed into a form: plain digits, with commas, spaces or ₦ allowed.
 * Empty gives undefined. Hex, exponents, negatives, too many decimals or more
 * than `max` are refused with a message saying which field.
 */
export function formNumber(v: unknown, what: string, o: { max: number; decimals: number }): number | undefined {
  const t = String(v ?? "").replace(/[,\s₦]/g, "");
  if (!t) return undefined;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) throw new AgentError(400, `${what} must be a plain number, like 1,500.`);
  if ((m[2] ?? "").length > o.decimals) throw new AgentError(400, o.decimals ? `${what} can have at most ${o.decimals} decimal places.` : `${what} must be a whole number.`);
  const n = Number(t);
  if (!(n > 0)) throw new AgentError(400, `${what} must be more than zero.`);
  if (n > o.max) throw new AgentError(400, `${what} can be at most ${o.max.toLocaleString("en-US")}.`);
  return n;
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

