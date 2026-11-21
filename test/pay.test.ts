import { existsSync } from "node:fs";
import { invoiceFromPath } from "../src/filestore.ts";
import { store } from "../src/store.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TEXTILE_REACTOR, TOKENS } from "../src/celo.ts";
import { loadHolds, loadLedger, saveFreelancers } from "../src/checks.ts";
import type { Call, Executor, SendResult } from "../src/executor.ts";
import type { TakerProof } from "../src/proof.ts";
import { anthropicExtractor } from "../src/invoice.ts";
import { buildCalls, payInvoice, type PayDeps } from "../src/pay.ts";
import { parseQuote } from "../src/textile.ts";
import { generateMetaKeys, stealthPrivateKey } from "../src/stealth.ts";
import { TextileClient } from "../src/textile.ts";
import { fakeFetch, freshState, writeFile } from "./helpers.ts";

const WALLET = getAddress("0x1234567890abcdef1234567890abcdef12345678");
const SWAP_DATA = "0xdeadbeef" as Hex;

class FakeExecutor implements Executor {
  readonly kind = "altana" as const;
  readonly address = WALLET;
  sent: Call[][] = [];
  async send(calls: Call[]): Promise<SendResult> {
    this.sent.push(calls);
    return { hashes: [("0x" + "ab".repeat(32)) as Hex], status: "CONFIRMED" };
  }
  async takerProof(): Promise<TakerProof> {
    return { nonce: ("0x" + "11".repeat(32)) as Hex, issuedAt: 1, signature: "0x1234" as Hex, scheme: "eip712" };
  }
}

function fakeReader(allowance = 0n): PublicClient {
  return {
    readContract: async () => allowance,
    getTransaction: async () => ({ input: "0x" }),
  } as unknown as PublicClient;
}

function textileReplying(takerPays: string, buyAmount: string, opts: { reactor?: Address; taker?: Address } = {}) {
  return fakeFetch((url) => {
    if (url.endsWith("/rfq/request")) {
      return {
        body: {
          data: {
            status: "quoted",
            rfqId: "rfq_1",
            claimToken: "claim_1",
            quote: {
              sellAmount: takerPays,
              buyAmount,
              feeAmount: "2000",
              takerPays,
              rateRay: "1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              reactor: opts.reactor ?? TEXTILE_REACTOR,
              taker: opts.taker ?? WALLET,
            },
            transactions: {
              approval: { to: TOKENS.USDT, data: "0x095ea7b3", value: "0", chainId: 42220 },
              swap: { to: opts.reactor ?? TEXTILE_REACTOR, data: SWAP_DATA, value: "0", chainId: 42220 },
            },
          },
        },
      };
    }
    if (url.endsWith("/rfq/preview")) {
      return { body: { data: { status: "preview", takerPays, buyAmount, feeAmount: "2000", rateRay: "1" } } };
    }
    return { body: { data: { status: "submitted" } } };
  });
}

describe("paying an invoice end to end (no network)", () => {
  let dir: string;
  const keys = generateMetaKeys();

  beforeEach(() => {
    dir = freshState();
    saveFreelancers([{ id: "ada", name: "Ada Obi", metaAddress: keys.metaAddress, maxInvoiceNgn: 500_000 }]);
  });

  function deps(executor: Executor, fetchFn: typeof fetch, extra: Partial<PayDeps> = {}): PayDeps {
    return {
      executor,
      textile: new TextileClient("https://textile.test/v2", "tx_live_test", fetchFn),
      reader: fakeReader(),
      code: "celo_test123",
      maxUsdt: 500,
      gasTopUpUsdt: 0.05,
      ...extra,
    };
  }

  it("asks Textile for the exact naira amount and pays it to a fresh private address", async () => {
    const invoice = writeFile(dir, "inv.json", JSON.stringify({ invoiceId: "INV-7", freelancer: "ada", amountNgn: 150000 }));
    const textile = textileReplying("103500000", "150000000000");
    const ex = new FakeExecutor();
    const out = await payInvoice(invoiceFromPath(invoice), deps(ex, textile.fn));

    expect(out.status).toBe("paid");
    if (out.status !== "paid") return;
    // Exact-output quote, bound to the paying wallet.
    expect(textile.calls[0]!.body).toMatchObject({ chainId: 42220, sellToken: TOKENS.USDT, buyToken: TOKENS.CNGN, buyAmount: "150000000000", taker: WALLET });
    expect((textile.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tx_live_test");
    // One atomic batch: approve → swap → payout → gas money.
    const calls = ex.sent[0]!;
    expect(calls.map((c) => c.label)).toEqual(["approve", "swap", "payout", "gas money"]);
    const payout = decodeFunctionData({ abi: erc20Abi, data: calls[2]!.data });
    expect(calls[2]!.to).toBe(TOKENS.CNGN);
    expect(payout.args).toEqual([out.plan.payout.stealthAddress, 150_000_000_000n]);
    // The freelancer, and only the freelancer, can open that address.
    const key = stealthPrivateKey(keys.spendingPrivateKey, keys.viewingPrivateKey, out.plan.payout.ephemeralPublicKey);
    expect(privateKeyToAccount(key).address).toBe(out.plan.payout.stealthAddress);
    // Textile was told the hash; ledger and receipt written, with no personal details.
    expect(textile.calls[1]!.url).toBe("https://textile.test/v2/rfq/rfq_1/submit");
    expect(loadLedger()).toHaveLength(1);
    const receipt = store().read<any>(out.receiptPath, null);
    expect(receipt.payout.ephemeralPublicKey).toBe(out.plan.payout.ephemeralPublicKey);
    expect(receipt.invoice.fingerprint).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out.plan.usdtCost).toBeCloseTo(103.5);
  });

  it("without an API key, proves control of the paying wallet instead", async () => {
    const invoice = writeFile(dir, "inv.json", JSON.stringify({ invoiceId: "INV-K", freelancer: "ada", amountNgn: 1000 }));
    const textile = textileReplying("700000", "1000000000");
    const out = await payInvoice(invoiceFromPath(invoice), {
      ...deps(new FakeExecutor(), textile.fn),
      textile: new TextileClient("https://textile.test/v2", undefined, textile.fn),
      textileKeyless: true,
    });
    expect(out.status).toBe("paid");
    expect(textile.calls[0]!.body).toMatchObject({ takerProof: { nonce: "0x" + "11".repeat(32), signature: "0x1234" } });
    expect((textile.calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("refuses to pay the same invoice twice", async () => {
    const invoice = writeFile(dir, "inv.json", JSON.stringify({ invoiceId: "INV-7", freelancer: "ada", amountNgn: 150000 }));
    const ex = new FakeExecutor();
    await payInvoice(invoiceFromPath(invoice), deps(ex, textileReplying("103500000", "150000000000").fn));
    const again = await payInvoice(invoiceFromPath(invoice), deps(ex, textileReplying("103500000", "150000000000").fn));
    expect(again.status).toBe("held");
    expect(ex.sent).toHaveLength(1);
  });

  it("ignores a wallet address written on the invoice", async () => {
    const attacker = "0x9999999999999999999999999999999999999999";
    const invoice = writeFile(dir, "inv.json", JSON.stringify({ invoiceId: "INV-8", freelancer: "ada", amountNgn: 1000, payTo: attacker }));
    const ex = new FakeExecutor();
    const out = await payInvoice(invoiceFromPath(invoice), deps(ex, textileReplying("700000", "1000000000").fn));
    expect(out.notes.join()).toMatch(/wallet address/);
    expect(JSON.stringify(ex.sent).toLowerCase()).not.toContain(attacker.slice(2));
  });

  it("holds when the dollar cost is above the client's ceiling, and sends nothing", async () => {
    const invoice = writeFile(dir, "inv.json", JSON.stringify({ invoiceId: "INV-9", freelancer: "ada", amountNgn: 150000 }));
    const ex = new FakeExecutor();
    const out = await payInvoice(invoiceFromPath(invoice), deps(ex, textileReplying("103500000", "150000000000").fn, { maxUsdt: 50 }));
    expect(out.status).toBe("held");
    expect(ex.sent).toHaveLength(0);
  });

  it("holds when the firm price is above what the client approved, even with holds approved", async () => {
    const invoice = writeFile(dir, "inv.json", JSON.stringify({ invoiceId: "INV-9b", freelancer: "ada", amountNgn: 150000 }));
    const ex = new FakeExecutor();
    const out = await payInvoice(invoiceFromPath(invoice), deps(ex, textileReplying("103500000", "150000000000").fn, { approvedUsdt: 103, approveHolds: true }));
    expect(out.status).toBe("held");
    if (out.status === "held") expect(out.holds[0]).toMatch(/price moved/);
    expect(ex.sent).toHaveLength(0);
    expect(loadHolds()[0]).toMatchObject({ invoiceId: "INV-9b", billedBy: "ada" });
  });

  it("a held invoice that is later paid is no longer listed as held", async () => {
    const invoice = writeFile(dir, "inv.json", JSON.stringify({ invoiceId: "INV-9c", freelancer: "ada", amountNgn: 150000 }));
    const ex = new FakeExecutor();
    await payInvoice(invoiceFromPath(invoice), deps(ex, textileReplying("103500000", "150000000000").fn, { approvedUsdt: 100 }));
    expect(loadHolds()).toHaveLength(1);
    const out = await payInvoice(invoiceFromPath(invoice), deps(ex, textileReplying("103500000", "150000000000").fn, { approvedUsdt: 104.6 }));
    expect(out.status).toBe("paid");
    expect(loadHolds()).toEqual([]);
  });

  it("refuses a quote that points at another contract", async () => {
    const invoice = writeFile(dir, "inv.json", JSON.stringify({ invoiceId: "INV-10", freelancer: "ada", amountNgn: 1000 }));
    const evil = textileReplying("700000", "1000000000", { reactor: getAddress("0x00000000000000000000000000000000000bad01") });
    await expect(payInvoice(invoiceFromPath(invoice), deps(new FakeExecutor(), evil.fn))).rejects.toThrow(/unexpected contract/);
  });

  it("refuses a quote that delivers less naira than billed", async () => {
    const invoice = writeFile(dir, "inv.json", JSON.stringify({ invoiceId: "INV-11", freelancer: "ada", amountNgn: 1000 }));
    await expect(payInvoice(invoiceFromPath(invoice), deps(new FakeExecutor(), textileReplying("700000", "999000000").fn))).rejects.toThrow(/less naira/);
  });

  it("dry run uses the preview: no wallet, no firm quote, nothing sent", async () => {
    const invoice = writeFile(dir, "inv.json", JSON.stringify({ invoiceId: "INV-12", freelancer: "ada", amountNgn: 1000 }));
    const textile = textileReplying("700000", "1000000000");
    const out = await payInvoice(invoiceFromPath(invoice), { ...deps(new FakeExecutor(), textile.fn, { dryRun: true }), executor: undefined });
    expect(out.status).toBe("planned");
    if (out.status === "planned") {
      expect(out.preview.steps).toEqual(["approve", "swap", "payout", "gas money"]);
      expect(out.preview.usdtCost).toBeCloseTo(0.7);
    }
    expect(textile.calls.map((c) => c.url)).toEqual(["https://textile.test/v2/rfq/preview"]);
    expect(textile.calls[0]!.body).not.toHaveProperty("taker");
    expect(existsSync(process.env.NAIRA_REACH_RECEIPTS!)).toBe(false);
  });

  it("skips approval when allowance is enough, and resets a non-zero one before approving", () => {
    const quote = parseQuote({
      rfqId: "r",
      claimToken: "c",
      quote: { takerPays: "700000", buyAmount: "1000000000", sellAmount: "700000", feeAmount: "0", rateRay: "1", expiresAt: "2099-01-01T00:00:00Z", reactor: TEXTILE_REACTOR, taker: WALLET },
      transactions: { swap: { to: TEXTILE_REACTOR, data: SWAP_DATA, value: "0", chainId: 42220 } },
    });
    const payout = { stealthAddress: WALLET, ephemeralPublicKey: "0x02" as Hex, viewTag: "0x01" as Hex };
    const labels = (allowance: bigint) =>
      buildCalls({ quote, payout, buyAmount: 1_000_000_000n, allowance, gasTopUp: 50_000n }).map((c) => c.label);
    expect(labels(10_000_000n)).toEqual(["swap", "payout", "gas money"]);
    expect(labels(5n)).toEqual(["reset allowance", "approve", "swap", "payout", "gas money"]);
    expect(labels(0n)).toEqual(["approve", "swap", "payout", "gas money"]);
  });

  it("reads a plain-text invoice with AI, sending only redacted text", async () => {
    const invoice = writeFile(dir, "inv.txt", "INVOICE #A-22\nFrom: Ada Obi (ada@mail.com, 08031234567)\nGTBank 0123456789\nTotal due: ₦45,000");
    const ai = fakeFetch(() => ({ body: { content: [{ type: "tool_use", input: { invoiceId: "A-22", freelancer: "Ada Obi", amountNgn: 45000 } }] } }));
    const out = await payInvoice(
      invoiceFromPath(invoice),
      deps(new FakeExecutor(), textileReplying("31000000", "45000000000").fn, { dryRun: true, extractor: anthropicExtractor("sk-test", "claude-sonnet-5-5", ai.fn) }),
    );
    expect(out.status).toBe("planned");
    const sent = JSON.stringify(ai.calls[0]!.body);
    expect(sent).not.toMatch(/ada@mail\.com|08031234567|0123456789/);
    expect(sent).toContain("45,000");
  });
});
