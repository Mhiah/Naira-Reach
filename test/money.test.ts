// The money path, attacked from every side: every call the agent builds decoded
// byte by byte, quotes that lie, prices that move (slippage), failures mid-way,
// and amounts with kobo.
import { beforeEach, describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData, erc20Abi, getAddress, parseAbi, slice, type Address, type Hex, type PublicClient } from "viem";
import { ANNOUNCER_ABI, ERC5564_ANNOUNCER } from "../src/announcer.ts";
import { TEXTILE_REACTOR, TOKENS } from "../src/celo.ts";
import { loadHolds, loadLedger, saveFreelancers } from "../src/checks.ts";
import type { Call, Executor, SendResult } from "../src/executor.ts";
import type { TakerProof } from "../src/proof.ts";
import { assertQuote, buildCalls, payInvoice, type PayDeps } from "../src/pay.ts";
import { generateMetaKeys, isMine, newStealthAddress, parseMetaAddress } from "../src/stealth.ts";
import { store } from "../src/store.ts";
import { parseQuote, quoteExpired, TextileClient, type FirmQuote } from "../src/textile.ts";
import { fakeFetch, freshState } from "./helpers.ts";

const WALLET = getAddress("0x1234567890abcdef1234567890abcdef12345678");
const SWAP = "0xdeadbeef" as Hex;
const enc = (o: unknown) => ({ name: "inv.json", bytes: new TextEncoder().encode(JSON.stringify(o)) });

class Wallet implements Executor {
  readonly kind = "altana" as const;
  readonly address = WALLET;
  sent: Call[][] = [];
  private readonly result: SendResult | Error;
  constructor(result: SendResult | Error = { hashes: [("0x" + "ab".repeat(32)) as Hex], status: "CONFIRMED" }) {
    this.result = result;
  }
  async send(calls: Call[]): Promise<SendResult> {
    this.sent.push(calls);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async takerProof(): Promise<TakerProof> {
    return { nonce: ("0x" + "11".repeat(32)) as Hex, issuedAt: 1, signature: "0x1234" as Hex, scheme: "eip712" };
  }
}

const reader = (allowance = 0n) => ({ readContract: async () => allowance, getTransaction: async () => ({ input: "0x" }) }) as unknown as PublicClient;

type QuoteOverrides = Partial<{ takerPays: string; buyAmount: string; reactor: Address; swapTo: Address; taker: Address; value: string; chainId: number; expiresAt: string; status: string; reason: string; httpStatus: number }>;

function textile(o: QuoteOverrides = {}, submitStatus = 200) {
  return fakeFetch((url) => {
    if (url.endsWith("/rfq/request")) {
      if (o.httpStatus) return { status: o.httpStatus, body: { error: "nope" } };
      return {
        body: {
          data: {
            status: o.status ?? "quoted",
            reason: o.reason,
            rfqId: "rfq_1",
            claimToken: "claim_1",
            quote: {
              sellAmount: o.takerPays ?? "1388823",
              buyAmount: o.buyAmount ?? "2000000000",
              feeAmount: "277",
              takerPays: o.takerPays ?? "1388823",
              rateRay: "1",
              expiresAt: o.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
              reactor: o.reactor ?? TEXTILE_REACTOR,
              taker: o.taker ?? WALLET,
            },
            transactions: { swap: { to: o.swapTo ?? o.reactor ?? TEXTILE_REACTOR, data: SWAP, value: o.value ?? "0", chainId: o.chainId ?? 42220 } },
          },
        },
      };
    }
    if (url.endsWith("/submit")) return { status: submitStatus, body: {} };
    return { body: { data: { status: "preview", takerPays: o.takerPays ?? "1388823", buyAmount: "2000000000", feeAmount: "277" } } };
  });
}

const keys = generateMetaKeys();

function deps(wallet: Executor, t: ReturnType<typeof textile>, extra: Partial<PayDeps> = {}): PayDeps {
  return { executor: wallet, textile: new TextileClient("https://textile.test/v2", "key", t.fn), reader: reader(), code: "celo_test", maxUsdt: 500, gasTopUpUsdt: 0.05, ...extra };
}

beforeEach(() => {
  freshState();
  saveFreelancers([{ id: "ada", name: "Ada Obi", metaAddress: keys.metaAddress, maxInvoiceNgn: 5_000_000 }]);
});

// ---------- the calls themselves ----------

describe("every call the agent sends, decoded", () => {
  const q = (takerPays: bigint): FirmQuote => ({
    rfqId: "r",
    claimToken: "c",
    quote: { sellAmount: String(takerPays), buyAmount: "2000000000", feeAmount: "0", takerPays: String(takerPays), rateRay: "1", expiresAt: new Date(Date.now() + 60_000).toISOString(), reactor: TEXTILE_REACTOR, taker: WALLET },
    transactions: { swap: { to: TEXTILE_REACTOR, data: SWAP, value: "0", chainId: 42220 } },
  });
  const payout = newStealthAddress(keys.metaAddress);

  it("approves exactly the USD₮ the swap takes, swaps, pays the exact naira, sends gas money, announces", () => {
    const calls = buildCalls({ quote: q(1_388_823n), payout, buyAmount: 2_000_000_000n, allowance: 0n, gasTopUp: 50_000n, announcer: ERC5564_ANNOUNCER });
    expect(calls.map((c) => c.label)).toEqual(["approve", "swap", "payout", "gas money", "announce"]);
    const [approve, swap, pay, gas, announce] = calls;
    expect(approve!.to).toBe(TOKENS.USDT);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data })).toMatchObject({ functionName: "approve", args: [TEXTILE_REACTOR, 1_388_823n] });
    expect(swap).toMatchObject({ to: TEXTILE_REACTOR, data: SWAP });
    expect(pay!.to).toBe(TOKENS.CNGN);
    expect(decodeFunctionData({ abi: erc20Abi, data: pay!.data })).toMatchObject({ functionName: "transfer", args: [payout.stealthAddress, 2_000_000_000n] });
    expect(gas!.to).toBe(TOKENS.USDT);
    expect(decodeFunctionData({ abi: erc20Abi, data: gas!.data })).toMatchObject({ functionName: "transfer", args: [payout.stealthAddress, 50_000n] });
    expect(calls.every((c) => !c.value)).toBe(true); // no CELO moves anywhere
    // The announcement: scheme 1, the payout address, its one-time key, and metadata the freelancer can read.
    const a = decodeFunctionData({ abi: ANNOUNCER_ABI, data: announce!.data });
    expect(announce!.to).toBe(ERC5564_ANNOUNCER);
    expect(a.args[0]).toBe(1n);
    expect(getAddress(a.args[1])).toBe(payout.stealthAddress);
    expect(a.args[2]).toBe(payout.ephemeralPublicKey);
    const meta = a.args[3] as Hex;
    expect(slice(meta, 0, 1)).toBe(payout.viewTag);
    expect(slice(meta, 1, 5)).toBe("0xa9059cbb");
    expect(getAddress(slice(meta, 5, 25))).toBe(TOKENS.CNGN);
    expect(BigInt(slice(meta, 25, 57))).toBe(2_000_000_000n);
    // Read back the way the freelancer's browser does.
    expect(isMine({ stealthAddress: getAddress(a.args[1]), ephemeralPublicKey: a.args[2], viewTag: slice(meta, 0, 1) }, parseMetaAddress(keys.metaAddress).spendingPublicKey, keys.viewingPrivateKey)).toBe(true);
  });

  it("skips the approval when enough is already approved, and resets a smaller one to zero first", () => {
    expect(buildCalls({ quote: q(1_000_000n), payout, buyAmount: 1n, allowance: 1_000_000n, gasTopUp: 0n }).map((c) => c.label)).toEqual(["swap", "payout"]);
    const calls = buildCalls({ quote: q(1_000_000n), payout, buyAmount: 1n, allowance: 5n, gasTopUp: 0n });
    expect(calls.map((c) => c.label)).toEqual(["reset allowance", "approve", "swap", "payout"]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data }).args).toEqual([TEXTILE_REACTOR, 0n]);
  });

  it("never approves more than the quote, so nothing is left for the reactor to take later", () => {
    for (const takerPays of [1n, 999_999n, 103_500_000n, 10n ** 12n]) {
      const c = buildCalls({ quote: q(takerPays), payout, buyAmount: 1n, allowance: 0n, gasTopUp: 0n }).find((x) => x.label === "approve")!;
      expect(decodeFunctionData({ abi: erc20Abi, data: c.data }).args[1]).toBe(takerPays);
    }
  });
});

// ---------- quotes that lie ----------

describe("quotes the agent refuses", () => {
  const cases: [string, QuoteOverrides, RegExp][] = [
    ["bound to another wallet", { taker: "0x000000000000000000000000000000000000dEaD" }, /different wallet/],
    ["pointing at another contract", { reactor: "0x000000000000000000000000000000000000bEEF" }, /unexpected contract/],
    ["whose swap goes to another contract", { swapTo: "0x000000000000000000000000000000000000bEEF" }, /unexpected contract/],
    ["delivering less naira than billed", { buyAmount: "1999999999" }, /less naira/],
    ["asking for CELO as well", { value: "1" }, /CELO/],
    ["for another network", { chainId: 1 }, /different network/],
    ["already expired", { expiresAt: new Date(Date.now() - 1000).toISOString() }, /expired/],
    ["about to expire", { expiresAt: new Date(Date.now() + 3000).toISOString() }, /expired/],
    ["with an unreadable expiry", { expiresAt: "soon" }, /expiry/],
    ["with an unreadable price", { takerPays: "1.5" }, /unreadable (sellAmount|takerPays)/],
    ["for nothing", { takerPays: "0" }, /for nothing/],
    ["that Textile couldn't fill", { status: "no_quotes", reason: "no maker" }, /No firm quote \(no_quotes: no maker\)/],
    ["that Textile refused", { httpStatus: 422 }, /returned 422/],
  ];
  for (const [what, o, msg] of cases) {
    it(`a quote ${what}: nothing is sent and nothing is recorded as paid`, async () => {
      const wallet = new Wallet();
      await expect(payInvoice(enc({ invoiceId: "INV-Q", freelancer: "ada", amountNgn: 2000 }), deps(wallet, textile(o)))).rejects.toThrow(msg);
      expect(wallet.sent).toHaveLength(0);
      expect(loadLedger()).toHaveLength(0);
    });
  }

  it("parses only well-formed quotes, and treats a bad expiry as expired", () => {
    expect(() => parseQuote({ rfqId: "r", claimToken: "c" })).toThrow(/missing/);
    const ok = parseQuote({ rfqId: "r", claimToken: "c", quote: { sellAmount: "1", buyAmount: "1", feeAmount: "0", takerPays: "1", rateRay: "1", expiresAt: new Date(Date.now() + 9000).toISOString(), reactor: TEXTILE_REACTOR, taker: WALLET }, transactions: { swap: { to: TEXTILE_REACTOR, data: "0x", value: "0", chainId: 42220 } } });
    expect(quoteExpired(ok)).toBe(false);
    expect(quoteExpired(ok, Date.now(), 10_000)).toBe(true);
    expect(quoteExpired({ ...ok, quote: { ...ok.quote, expiresAt: "garbage" } })).toBe(true);
    expect(() => assertQuote(ok, WALLET, 2n)).toThrow(/less naira/);
  });
});

// ---------- slippage: the price moving between approval and payment ----------

describe("slippage", () => {
  it("pays when the firm price is at or under what the client approved", async () => {
    for (const takerPays of ["1388823", "1400000"]) {
      freshState();
      saveFreelancers([{ id: "ada", name: "Ada Obi", metaAddress: keys.metaAddress }]);
      const out = await payInvoice(enc({ invoiceId: "INV-S", freelancer: "ada", amountNgn: 2000 }), deps(new Wallet(), textile({ takerPays }), { approvedUsdt: 1.4 }));
      expect(out.status).toBe("paid");
    }
  });

  it("holds, sends nothing, and says why when the price moved above the approval", async () => {
    const wallet = new Wallet();
    const out = await payInvoice(enc({ invoiceId: "INV-S", freelancer: "ada", amountNgn: 2000 }), deps(wallet, textile({ takerPays: "1400001" }), { approvedUsdt: 1.4 }));
    expect(out).toMatchObject({ status: "held" });
    if (out.status === "held") expect(out.holds[0]).toMatch(/price moved: it now costs 1\.40 USD₮ and you approved up to 1\.40/);
    expect(wallet.sent).toHaveLength(0);
    expect(loadHolds()[0]!.reasons[0]).toMatch(/price moved/);
  });

  it("can't be talked past the price guard by 'pay anyway'", async () => {
    const wallet = new Wallet();
    const out = await payInvoice(enc({ invoiceId: "INV-S", freelancer: "ada", amountNgn: 2000 }), deps(wallet, textile({ takerPays: "2000000" }), { approvedUsdt: 1.4, approveHolds: true }));
    expect(out.status).toBe("held");
    expect(wallet.sent).toHaveLength(0);
  });

  it("the site's 1% allowance: a 1% move pays, anything more is held", () => {
    // Mirrors web/app.js approveLimit: the indicative price plus 1%, rounded up to the cent.
    const approveLimit = (usdtCost: number) => Math.ceil((usdtCost * 1.01 + 1e-9) * 100) / 100;
    for (const cost of [0.74, 1.39, 103.86, 499.99]) {
      const limit = approveLimit(cost);
      expect(limit).toBeGreaterThanOrEqual(cost * 1.01 - 1e-9);
      expect(limit).toBeLessThan(cost * 1.01 + 0.01 + 1e-9);
    }
  });

  it("keeps the client's per-invoice ceiling", async () => {
    const wallet = new Wallet();
    const out = await payInvoice(enc({ invoiceId: "INV-C", freelancer: "ada", amountNgn: 1_000_000 }), deps(wallet, textile({ takerPays: "693000000", buyAmount: "1000000000000" }), { maxUsdt: 500 }));
    expect(out.status).toBe("held");
    expect(wallet.sent).toHaveLength(0);
  });
});

// ---------- failures mid-way and repeat payments ----------

describe("when sending goes wrong", () => {
  it("a failed transaction is reported, not recorded as paid, and can be tried again", async () => {
    const failed = new Wallet({ hashes: [("0x" + "cd".repeat(32)) as Hex], status: "FAILED" });
    const out = await payInvoice(enc({ invoiceId: "INV-F", freelancer: "ada", amountNgn: 2000 }), deps(failed, textile()));
    expect(out.status).toBe("failed");
    expect(loadLedger()).toHaveLength(0);
    expect(store().list("receipts/")).toHaveLength(0);
    const again = await payInvoice(enc({ invoiceId: "INV-F", freelancer: "ada", amountNgn: 2000 }), deps(new Wallet(), textile()));
    expect(again.status).toBe("paid");
  });

  it("a wallet error leaves no trace of a payment", async () => {
    await expect(payInvoice(enc({ invoiceId: "INV-E", freelancer: "ada", amountNgn: 2000 }), deps(new Wallet(new Error("relay down")), textile()))).rejects.toThrow(/relay down/);
    expect(loadLedger()).toHaveLength(0);
  });

  it("Textile not hearing about the fill doesn't undo a payment", async () => {
    const out = await payInvoice(enc({ invoiceId: "INV-T", freelancer: "ada", amountNgn: 2000 }), deps(new Wallet(), textile({}, 500)));
    expect(out.status).toBe("paid");
  });

  it("the same invoice is never paid twice, even resent with a new id or as a copy", async () => {
    const first = await payInvoice(enc({ invoiceId: "INV-D", freelancer: "ada", amountNgn: 2000 }), deps(new Wallet(), textile()));
    expect(first.status).toBe("paid");
    const wallet = new Wallet();
    const sameFile = await payInvoice(enc({ invoiceId: "INV-D", freelancer: "ada", amountNgn: 2000 }), deps(wallet, textile()));
    const sameId = await payInvoice(enc({ invoiceId: "INV-D", freelancer: "ada", amountNgn: 2500 }), deps(wallet, textile()));
    expect(sameFile.status).toBe("held");
    expect(sameId.status).toBe("held");
    expect(wallet.sent).toHaveLength(0);
  });
});

// ---------- amounts ----------

describe("naira amounts reach the chain exactly", () => {
  for (const amount of [2000, 1438.5, 1_053_773.15, 2_184_493.68, 150_000.000001]) {
    it(`₦${amount} becomes exactly the right cNGN units`, async () => {
      const units = BigInt(Math.round(amount * 1e6)).toString();
      const wallet = new Wallet();
      const t = textile({ buyAmount: units });
      const out = await payInvoice(enc({ invoiceId: `INV-${amount}`, freelancer: "ada", amountNgn: amount }), deps(wallet, t));
      expect(out.status).toBe("paid");
      expect(t.calls[0]!.body).toMatchObject({ buyAmount: units });
      const pay = wallet.sent[0]!.find((c) => c.label === "payout")!;
      expect(decodeFunctionData({ abi: erc20Abi, data: pay.data }).args[1]).toBe(BigInt(units));
    });
  }

  it("refuses amounts that would be mistyped or dangerous", async () => {
    for (const amountNgn of [true, "0x10", "1e3", 1e21, -5, 0, "2,000", "2000.1234567", 1_000_000_001]) {
      await expect(payInvoice(enc({ invoiceId: "INV-X", freelancer: "ada", amountNgn }), deps(new Wallet(), textile()))).rejects.toThrow(/amountNgn/);
    }
  });
});

// keep the imports honest
void parseAbi;
void decodeAbiParameters;
