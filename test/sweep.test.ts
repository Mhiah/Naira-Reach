// Edge cases and failure paths for today's changes: payout scanning, the rate
// fallback, Textile's minimum, automatic delivery failures, the Textile proxy
// and the browser's locked store.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, pad, toHex, type PublicClient } from "viem";
import { createAgent, type Actions } from "../src/agent.ts";
import { ANNOUNCEMENT_EVENT, ANNOUNCEMENTS_FROM_BLOCK, ERC5564_ANNOUNCER } from "../src/announcer.ts";
import { scan } from "../src/browser/receive.ts";
import { createVaultStore, VAULT_ITEM, type KV } from "../src/browser/vaultstore.ts";
import { TOKENS } from "../src/celo.ts";
import { recordPaid, saveFreelancers } from "../src/checks.ts";
import { reviewInvoice } from "../src/pay.ts";
import { erc20Metadata, generateMetaKeys, newStealthAddress } from "../src/stealth.ts";
import { store } from "../src/store.ts";
import type { TextileClient } from "../src/textile.ts";
import { freshState } from "./helpers.ts";

// ---------- a tiny Celo RPC for the scanner ----------

type Log = Record<string, unknown>;
let rpc: Server | undefined;
let rpcUrl = "";
let rpcLogs: Log[] = [];
let latest = Number(ANNOUNCEMENTS_FROM_BLOCK) + 12_000;
let getLogsCalls: { from: number; to: number }[] = [];
let failGetLogs = 0;

async function startRpc() {
  rpc = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const one = (m: { id: number; method: string; params: any[] }) => {
        let result: unknown = "0x0";
        if (m.method === "eth_blockNumber") result = toHex(latest);
        if (m.method === "eth_chainId") result = toHex(42220);
        if (m.method === "eth_getLogs") {
          const from = Number(m.params[0].fromBlock), to = Number(m.params[0].toBlock);
          getLogsCalls.push({ from, to });
          if (failGetLogs > 0) {
            failGetLogs--;
            return { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "busy" } };
          }
          result = rpcLogs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
        }
        if (m.method === "eth_getBlockByNumber") {
          const z = "0x" + "00".repeat(32);
          result = { number: m.params[0], hash: z, parentHash: z, timestamp: toHex(1_795_300_000), nonce: "0x0000000000000000", sha3Uncles: z, logsBloom: "0x" + "00".repeat(256), transactionsRoot: z, stateRoot: z, receiptsRoot: z, miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x0", gasLimit: "0x0", gasUsed: "0x0", transactions: [], uncles: [] };
        }
        return { jsonrpc: "2.0", id: m.id, result };
      };
      const parsed = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((r) => rpc!.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(rpc!.address() as AddressInfo).port}`;
}

function announcement(meta: string, opts: { block: number; amount?: bigint; token?: `0x${string}`; metadata?: `0x${string}`; ephemeral?: `0x${string}`; i?: number }) {
  const p = newStealthAddress(meta);
  const topics = encodeEventTopics({ abi: [ANNOUNCEMENT_EVENT], eventName: "Announcement", args: { schemeId: 1n, stealthAddress: p.stealthAddress, caller: "0xB2441B175d620A3Fd5CDef28fA1c6957e6224431" } });
  const data = encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [opts.ephemeral ?? p.ephemeralPublicKey, opts.metadata ?? erc20Metadata(p.viewTag, opts.amount ?? 2000_000000n, opts.token ?? TOKENS.CNGN)]);
  const i = opts.i ?? 1;
  return { log: { address: ERC5564_ANNOUNCER.toLowerCase(), topics, data, blockNumber: toHex(opts.block), transactionHash: pad(toHex(i), { size: 32 }), transactionIndex: "0x0", blockHash: pad(toHex(opts.block), { size: 32 }), logIndex: toHex(i), removed: false }, p };
}

describe("finding payouts from announcements", () => {
  beforeEach(async () => {
    rpcLogs = [];
    getLogsCalls = [];
    failGetLogs = 0;
    latest = Number(ANNOUNCEMENTS_FROM_BLOCK) + 12_000;
    await startRpc();
  });
  afterEach(() => rpc?.close());

  it("finds only this freelancer's payouts, with the naira amount and date", async () => {
    const me = generateMetaKeys(), other = generateMetaKeys();
    const mine = announcement(me.metaAddress, { block: Number(ANNOUNCEMENTS_FROM_BLOCK) + 100, amount: 150_000_000000n, i: 1 });
    rpcLogs = [announcement(other.metaAddress, { block: Number(ANNOUNCEMENTS_FROM_BLOCK) + 50, i: 2 }).log, mine.log, announcement(other.metaAddress, { block: Number(ANNOUNCEMENTS_FROM_BLOCK) + 9000, i: 3 }).log];
    const out = await scan({ rpcUrl, keys: me });
    expect(out.found).toHaveLength(1);
    expect(out.found[0]).toMatchObject({ stealthAddress: getAddress(mine.p.stealthAddress), amountNgn: 150_000, from: "0xB2441B175d620A3Fd5CDef28fA1c6957e6224431" });
    expect(out.found[0]!.paidAt).toBe(new Date(1_795_300_000 * 1000).toISOString());
    expect(out.scannedTo).toBe(String(latest));
  });

  it("searches 5,000 blocks at a time, from the start block, with nothing skipped", async () => {
    const me = generateMetaKeys();
    await scan({ rpcUrl, keys: me });
    const sorted = [...getLogsCalls].sort((a, b) => a.from - b.from);
    expect(sorted[0]!.from).toBe(Number(ANNOUNCEMENTS_FROM_BLOCK));
    expect(sorted.at(-1)!.to).toBe(latest);
    for (const r of sorted) expect(r.to - r.from + 1).toBeLessThanOrEqual(5000);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.from).toBe(sorted[i - 1]!.to + 1);
  });

  it("on the next check, searches only new blocks", async () => {
    const me = generateMetaKeys();
    await scan({ rpcUrl, keys: me, from: String(latest - 10) });
    expect(getLogsCalls).toEqual([{ from: latest - 9, to: latest }]);
    getLogsCalls = [];
    await scan({ rpcUrl, keys: me, from: String(latest) });
    expect(getLogsCalls).toEqual([]);
    // A saved point from before the start block is moved up to it.
    getLogsCalls = [];
    await scan({ rpcUrl, keys: me, from: "5" });
    expect(Math.min(...getLogsCalls.map((c) => c.from))).toBe(Number(ANNOUNCEMENTS_FROM_BLOCK));
  });

  it("ignores junk anyone could announce, and payouts in other tokens show ₦0", async () => {
    const me = generateMetaKeys();
    const b = Number(ANNOUNCEMENTS_FROM_BLOCK) + 10;
    const usdt = announcement(me.metaAddress, { block: b, token: TOKENS.USDT, amount: 5_000000n, i: 1 });
    rpcLogs = [
      announcement(me.metaAddress, { block: b, ephemeral: ("0x02" + "00".repeat(32)) as `0x${string}`, i: 2 }).log, // not a curve point
      announcement(me.metaAddress, { block: b, metadata: "0x", i: 3 }).log, // no view tag
      announcement(me.metaAddress, { block: b, ephemeral: "0x1234", i: 4 }).log, // too short
      usdt.log,
    ];
    const out = await scan({ rpcUrl, keys: me });
    expect(out.found.map((f) => f.stealthAddress)).toEqual([getAddress(usdt.p.stealthAddress)]);
    expect(out.found[0]!.amountNgn).toBe(0);
  });

  it("retries a busy search once, and reports a second failure instead of skipping blocks", async () => {
    const me = generateMetaKeys();
    latest = Number(ANNOUNCEMENTS_FROM_BLOCK) + 100;
    failGetLogs = 1;
    await expect(scan({ rpcUrl, keys: me })).resolves.toMatchObject({ found: [] });
    failGetLogs = 2;
    await expect(scan({ rpcUrl, keys: me })).rejects.toThrow();
  });
});

// ---------- the agent: rate fallback and delivery failures ----------

const WALLET = "0xB2441B175d620A3Fd5CDef28fA1c6957e6224431";

function agentWith(opts: { textile?: Partial<TextileClient>; code?: () => string; actions?: Partial<Actions>; clock?: { t: number } }) {
  const clock = opts.clock ?? { t: Date.parse("2026-11-22T08:00:00Z") };
  const reader = {
    readContract: async () => 0n,
    getBalance: async () => 0n,
    getCode: async () => (opts.code ? opts.code() : "0x"),
  } as unknown as PublicClient;
  store().write("client.json", { walletAddress: WALLET, activatedAt: "2026-11-20T09:00:00Z" });
  return createAgent({
    textile: { preview: async () => ({ takerPays: "69300000", feeAmount: "14000" }), ...opts.textile } as unknown as TextileClient,
    textileKeyless: true,
    reader,
    adminKey: () => ("0x" + "4c".repeat(32)) as `0x${string}`,
    hasAdminKey: () => true,
    attributionCode: () => "celo_test",
    maxInvoiceUsdt: 500,
    gasTopUpUsdt: 0.05,
    actions: opts.actions,
    now: () => clock.t,
  });
}

function paid(id: string, announced = false) {
  const name = `receipts/${id}-1.json`;
  const p = newStealthAddress(generateMetaKeys().metaAddress);
  store().write(name, { invoice: { invoiceId: id, amountNgn: 2000 }, cost: { usdt: 1.39 }, payout: { ...p, cngn: 2000, gasMoneyUsdt: 0.05, ...(announced ? { announced: { by: "agent", hash: "0x01" } } : {}) }, transactions: [] });
  recordPaid({ invoiceId: id, freelancerId: "ada", fingerprint: ("0x" + id.length.toString(16).padStart(2, "0")) as `0x${string}`, amountNgn: 2000, paidAt: "2026-11-21T12:00:00Z", receipt: name });
  return name;
}

describe("today's rate", () => {
  beforeEach(() => void freshState());

  it("keeps the last price for 30 minutes when Textile doesn't answer, and says how old it is", async () => {
    const clock = { t: Date.parse("2026-11-22T08:00:00Z") };
    let up = true;
    let asked = 0;
    const agent = agentWith({ clock, textile: { preview: async () => (asked++, up ? { takerPays: "69300000", feeAmount: "14000" } : Promise.reject(new Error("timeout"))) } as never });
    const first = (await agent.dispatch("GET", "/state")) as any;
    expect(first.rate).toMatchObject({ ok: true, asOf: clock.t });
    expect(first.rate.ngnPerUsdt).toBeCloseTo(1443.0, 0);
    up = false;
    clock.t += 10 * 60_000;
    asked = 0;
    const stale = (await agent.dispatch("GET", "/state")) as any;
    expect(stale.rate).toMatchObject({ ok: true, asOf: Date.parse("2026-11-22T08:00:00Z") });
    expect(asked).toBe(2); // asked twice before falling back
    clock.t += 25 * 60_000;
    const gone = (await agent.dispatch("GET", "/state")) as any;
    expect(gone.rate).toMatchObject({ ok: false });
  });

  it("asks Textile at most once a minute", async () => {
    const clock = { t: Date.parse("2026-11-22T08:00:00Z") };
    let asked = 0;
    const agent = agentWith({ clock, textile: { preview: async () => (asked++, { takerPays: "69300000", feeAmount: "0" }) } as never });
    await agent.dispatch("GET", "/state");
    clock.t += 30_000;
    await agent.dispatch("GET", "/state");
    expect(asked).toBe(1);
    clock.t += 31_000;
    await agent.dispatch("GET", "/state");
    expect(asked).toBe(2);
  });
});

describe("Textile's smallest swap", () => {
  beforeEach(() => void freshState());
  const invoice = (amountNgn: number) => ({ name: "inv.json", bytes: new TextEncoder().encode(JSON.stringify({ invoiceId: `INV-${amountNgn}`, freelancer: "ada", amountNgn })) });
  const textile = (takerPays: number) => ({ preview: async () => ({ takerPays: String(takerPays), feeAmount: "0" }) }) as unknown as TextileClient;

  it("holds below 1 USD₮ and lets exactly 1 USD₮ through", async () => {
    saveFreelancers([{ id: "ada", name: "Ada Obi", metaAddress: generateMetaKeys().metaAddress }]);
    const deps = { maxUsdt: 500, gasTopUpUsdt: 0.05, weekLeft: { usdt: 100, cngn: 1_000_000 } };
    const below = await reviewInvoice(invoice(1438), { ...deps, textile: textile(999_999) });
    expect(below.rows.find((r) => r.title === "Below Textile's smallest swap")).toMatchObject({ hold: "block" });
    expect(below.canOverride).toBe(false);
    const at = await reviewInvoice(invoice(1444), { ...deps, textile: textile(1_000_000) });
    expect(at.rows.some((r) => r.title === "Below Textile's smallest swap")).toBe(false);
    expect(at.holds).toEqual([]);
  });

  it("says nothing about the minimum when there's no price", async () => {
    saveFreelancers([{ id: "ada", name: "Ada Obi", metaAddress: generateMetaKeys().metaAddress }]);
    const r = await reviewInvoice(invoice(500), { maxUsdt: 500, gasTopUpUsdt: 0.05, textile: { preview: async () => Promise.reject(new Error("down")) } as unknown as TextileClient });
    expect(r.rows.some((x) => x.title === "Below Textile's smallest swap")).toBe(false);
    expect(r.rows.some((x) => x.title === "No price from Textile")).toBe(true);
  });
});

describe("automatic delivery when things go wrong", () => {
  beforeEach(() => void freshState());

  it("reports a failed deployment and marks nothing", async () => {
    const file = paid("TEST-1");
    const agent = agentWith({ actions: { walletCalls: async () => ({ status: "FAILED" }) } });
    await expect(agent.dispatch("POST", "/delivery/setup")).rejects.toThrow(/failed/);
    expect(store().read<any>(file, null).payout.announced).toBeUndefined();
  });

  it("notices when the announcer still isn't there after a 'confirmed' deployment", async () => {
    paid("TEST-1");
    const agent = agentWith({ actions: { walletCalls: async () => ({ status: "CONFIRMED", hash: "0x01" }) } });
    await expect(agent.dispatch("POST", "/delivery/setup")).rejects.toThrow(/didn't appear/);
  });

  it("leaves payouts pending if the announcement fails, so it can be tried again", async () => {
    const file = paid("TEST-1");
    let n = 0;
    const agent = agentWith({ code: () => "0x6080", actions: { walletCalls: async () => (n++ ? { status: "CONFIRMED", hash: "0x0a" } : { status: "FAILED" }) } });
    await expect(agent.dispatch("POST", "/delivery/setup")).rejects.toThrow(/failed/);
    expect(((await agent.dispatch("GET", "/state")) as any).delivery.pending).toBe(1);
    await agent.dispatch("POST", "/delivery/setup");
    expect(store().read<any>(file, null).payout.announced).toEqual({ by: "wallet", hash: "0x0a" });
    expect(((await agent.dispatch("GET", "/state")) as any).delivery.pending).toBe(0);
  });

  it("announces several earlier payouts in one transaction, skipping ones already announced", async () => {
    paid("A-1");
    paid("A-2");
    paid("A-3", true);
    const sent: number[] = [];
    const agent = agentWith({ code: () => "0x6080", actions: { walletCalls: async (calls) => (sent.push(calls.length), { status: "CONFIRMED", hash: "0x0b" }) } });
    expect(await agent.dispatch("POST", "/delivery/setup")).toEqual({ announced: 2, hash: "0x0b" });
    expect(sent).toEqual([2]);
  });

  it("still reports a payment as paid when the follow-up announcement fails", async () => {
    saveFreelancers([{ id: "ada", name: "Ada Obi", metaAddress: generateMetaKeys().metaAddress }]);
    const agent = agentWith({
      code: () => "0x6080",
      actions: {
        walletCalls: async () => ({ status: "FAILED" }),
        pay: async () => {
          const name = paid("INV-P");
          return {
            status: "paid",
            plan: { invoice: { invoiceId: "INV-P", amountNgn: 2000 }, freelancer: { name: "Ada Obi" }, usdtCost: 1.39, payout: { stealthAddress: "0x" + "12".repeat(20) } },
            receiptPath: name,
            hashes: [],
            tags: [],
            notes: [],
          } as never;
        },
      },
    });
    const up = (await agent.dispatch("POST", "/invoices", { name: "i.json", data: Buffer.from(JSON.stringify({ invoiceId: "INV-P", freelancer: "ada", amountNgn: 2000 })).toString("base64") })) as any;
    const out = (await agent.dispatch("POST", `/invoices/${up.id}/pay`, { approvedUsdt: 2 })) as any;
    expect(out).toMatchObject({ status: "paid", delivered: false });
    expect(((await agent.dispatch("GET", "/state")) as any).delivery.pending).toBe(1);
  });

  it("refuses unknown requests and silly key limits", async () => {
    const agent = agentWith({});
    await expect(agent.dispatch("GET", "/nothing")).rejects.toThrow(/No such action/);
    await expect(agent.dispatch("POST", "/delivery/other")).rejects.toThrow(/No such action/);
    await expect(agent.dispatch("POST", "/session/grant", { usdtPerWeek: 10, cngnPerWeek: 10_000, days: 91 })).rejects.toThrow(/90 days/);
    await expect(agent.dispatch("POST", "/session/grant", { usdtPerWeek: 10 })).rejects.toThrow(/all three/);
  });
});

// ---------- the Textile proxy ----------

describe("Textile proxy, the awkward cases", async () => {
  const modPath = "../web/api/textile.mjs";
  const { handle } = (await import(modPath)) as { handle: (r: Request, f: typeof fetch) => Promise<Response> };
  const SITE = "https://nairareach.myacxt.site";
  const req = (p: string, init: RequestInit = {}) => new Request(`${SITE}/api/textile?p=${encodeURIComponent(p)}`, init);
  const quote = JSON.stringify({ chainId: 42220, sellToken: TOKENS.USDT, buyToken: TOKENS.CNGN, buyAmount: "2000000000" });

  it("refuses big bodies, wrong methods and tricky paths", async () => {
    const never = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    expect((await handle(req("rfq/preview", { method: "POST", body: "x".repeat(70_000) }), never)).status).toBe(413);
    expect((await handle(req("rfq/abc/submit"), never)).status).toBe(405);
    expect((await handle(req("rfq/abc", { method: "POST", body: "{}" }), never)).status).toBe(405);
    expect((await handle(req("rfq/../../admin"), never)).status).toBe(404);
    expect((await handle(req("rfq/abc/submit/more", { method: "POST", body: "{}" }), never)).status).toBe(404);
    expect((await handle(req("rfq/preview", { method: "POST", body: "not json" }), never)).status).toBe(400);
    expect((await handle(req("https://evil.test/rfq/preview"), never)).status).toBe(404);
  });

  it("passes Textile's own errors through, and answers 502 when Textile is down", async () => {
    const r422 = await handle(req("rfq/request", { method: "POST", body: quote }), (async () => new Response('{"error":"too small"}', { status: 422, headers: { "content-type": "application/json" } })) as unknown as typeof fetch);
    expect(r422.status).toBe(422);
    expect(await r422.json()).toEqual({ error: "too small" });
    const down = await handle(req("rfq/request", { method: "POST", body: quote }), (async () => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch);
    expect(down.status).toBe(502);
  });

  it("caps the claim header it forwards", async () => {
    let sent = "";
    await handle(req("rfq/abc", { headers: { "x-rfq-claim": "c".repeat(10_000) } }), (async (_u: string, init: RequestInit) => ((sent = (init.headers as Record<string, string>)["x-rfq-claim"]!), new Response("{}"))) as unknown as typeof fetch);
    expect(sent.length).toBe(4096);
  });
});

// ---------- the locked store in the browser ----------

describe("locked store, more cases", () => {
  const FAST = 100_000;
  const kv = () => {
    const m = new Map<string, string>();
    return { m, kv: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } satisfies KV };
  };

  it("saves what was written before locking", async () => {
    const { kv: a } = kv();
    const v = createVaultStore(a, { iterations: FAST });
    await v.create("correct horse battery", { "admin.key": { privateKey: "0x01" } });
    v.store.write("ledger.json", [{ invoiceId: "X" }]);
    await v.lock();
    await v.unlock("correct horse battery");
    expect(v.store.read("ledger.json", [])).toEqual([{ invoiceId: "X" }]);
  });

  it("picks up what another tab saved, with the same password", async () => {
    const shared = kv();
    const tab1 = createVaultStore(shared.kv, { iterations: FAST });
    await tab1.create("correct horse battery", { "admin.key": { privateKey: "0x01" } });
    const tab2 = createVaultStore(shared.kv, { iterations: FAST });
    await tab2.unlock("correct horse battery");
    tab1.store.write("freelancers.json", [{ id: "ada" }]);
    await tab1.flush();
    await tab2.reload(shared.m.get(VAULT_ITEM)!);
    expect(tab2.store.read("freelancers.json", [])).toEqual([{ id: "ada" }]);
  });

  it("says so plainly when the browser is out of room", async () => {
    const full: KV = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} };
    const v = createVaultStore(full, { iterations: FAST });
    await expect(v.create("correct horse battery", {})).rejects.toThrow(/no room left/);
  });

  it("refuses a file that isn't a Naira Reach agent, and a backup with no wallet key", async () => {
    const v = createVaultStore(kv().kv, { iterations: FAST });
    await expect(v.importFile('{"hello":1}', "correct horse battery")).rejects.toThrow(/isn't a Naira Reach/);
    const other = createVaultStore(kv().kv, { iterations: FAST });
    await other.create("correct horse battery", { "freelancers.json": [] });
    const text = await other.backup();
    await expect(v.importFile(text, "correct horse battery")).rejects.toThrow(/no wallet key/);
  });
});
