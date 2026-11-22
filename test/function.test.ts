// Does the code do what it promises, end to end? These follow one payment from the
// client's key limits, through the calls the wallet would accept, to the
// freelancer's browser finding it, plus the inputs people actually type.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, pad, toFunctionSelector, toHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { createAgent } from "../src/agent.ts";
import { agentPermissions } from "../src/altana.ts";
import { ANNOUNCEMENT_EVENT, ANNOUNCEMENTS_FROM_BLOCK, ANNOUNCER_ABI, ERC5564_ANNOUNCER } from "../src/announcer.ts";
import { scan } from "../src/browser/receive.ts";
import { DECIMALS, TEXTILE_REACTOR, TOKENS } from "../src/celo.ts";
import { findFreelancer, saveFreelancers, type Freelancer } from "../src/checks.ts";
import type { Call, Executor, SendResult } from "../src/executor.ts";
import { redact } from "../src/invoice.ts";
import type { TakerProof } from "../src/proof.ts";
import { payInvoice } from "../src/pay.ts";
import { generateMetaKeys, stealthPrivateKey } from "../src/stealth.ts";
import { store } from "../src/store.ts";
import { readTag, tagCalldata } from "../src/tag.ts";
import { TextileClient, type FirmQuote } from "../src/textile.ts";
import { fakeFetch, freshState } from "./helpers.ts";

const WALLET = getAddress("0x1234567890abcdef1234567890abcdef12345678");
const SWAP = "0xdeadbeef" as Hex;
const keys = generateMetaKeys();
const enc = (o: unknown) => ({ name: "inv.json", bytes: new TextEncoder().encode(JSON.stringify(o)) });

class Wallet implements Executor {
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

/** Textile answering at a fixed ₦1,440 per USD₮ for whatever naira is asked. */
function textile() {
  return fakeFetch((url, init) => {
    const want = init.body ? BigInt(JSON.parse(String(init.body)).buyAmount) : 0n;
    const pays = (want * 1_000_000n + 1_440_000_000n - 1n) / 1_440_000_000n; // round up
    if (url.endsWith("/rfq/request")) {
      const quote: FirmQuote["quote"] = { sellAmount: String(pays), buyAmount: String(want), feeAmount: "0", takerPays: String(pays), rateRay: "1", expiresAt: new Date(Date.now() + 60_000).toISOString(), reactor: TEXTILE_REACTOR, taker: WALLET };
      return { body: { data: { status: "quoted", rfqId: "rfq_1", claimToken: "claim_1", quote, transactions: { swap: { to: TEXTILE_REACTOR, data: SWAP, value: "0", chainId: 42220 } } } } };
    }
    if (url.endsWith("/submit")) return { body: {} };
    return { body: { data: { status: "preview", takerPays: String(pays), buyAmount: String(want), feeAmount: "0" } } };
  });
}

const reader = (allowance = 0n) => ({ readContract: async () => allowance, getTransaction: async () => ({ input: "0x" }) }) as unknown as PublicClient;

let invoiceNo = 0;
async function payOnce(amountNgn: number, allowance = 0n) {
  const wallet = new Wallet();
  const t = textile();
  const out = await payInvoice(enc({ invoiceId: `INV-${++invoiceNo}`, freelancer: "Ada Obi", amountNgn, description: `Work ${invoiceNo}` }), {
    executor: wallet,
    textile: new TextileClient("https://textile.test/v2", "key", t.fn),
    reader: reader(allowance),
    code: "celo_test",
    maxUsdt: 1_000_000,
    gasTopUpUsdt: 0.05,
    announcer: ERC5564_ANNOUNCER,
  });
  return { out, calls: wallet.sent[0] ?? [] };
}

/** Would the wallet accept this call under the agent's key? Same rule as Altana: target, then selector if one is set. */
function allowed(perms: ReturnType<typeof agentPermissions>, c: Call) {
  return (perms.calls as { to?: Address; signature?: string }[]).some((p) => !!p.to && getAddress(p.to) === getAddress(c.to) && (!p.signature || c.data.startsWith(toFunctionSelector(p.signature))));
}

beforeEach(() => {
  freshState();
  saveFreelancers([{ id: "ada", name: "Ada Obi", metaAddress: keys.metaAddress, maxInvoiceNgn: 1_000_000_000 }]);
});

// ---------- the client's key and the calls it must allow ----------

describe("the agent's key allows exactly what a payment needs", () => {
  const perms = agentPermissions({ usdtPerWeek: 10, cngnPerWeek: 15_000, days: 14, announcer: ERC5564_ANNOUNCER });

  it("every call in a real payment is one the key allows, and every call carries the tag", async () => {
    for (const allowance of [0n, 5n, 10n ** 12n]) {
      const { out, calls } = await payOnce(150_000, allowance);
      expect(out.status).toBe("paid");
      expect(calls.length).toBeGreaterThanOrEqual(4);
      for (const c of calls) {
        // The wallet sees each call with the attribution tag on the end, as the executor sends it.
        const sent = { ...c, data: tagCalldata(c.data, "celo_test") };
        expect(allowed(perms, sent), `${c.label} → ${c.to}`).toBe(true);
        expect(readTag(sent.data)).toContain("celo_test");
        expect(c.value ?? 0n).toBe(0n);
      }
    }
  });

  it("a key given before announcing was added can't announce, so the wallet announces instead", async () => {
    const old = agentPermissions({ usdtPerWeek: 10, cngnPerWeek: 15_000, days: 14 });
    const { calls } = await payOnce(2_000);
    const announce = calls.find((c) => c.label === "announce")!;
    expect(allowed(old, announce)).toBe(false);
    expect(calls.filter((c) => c.label !== "announce").every((c) => allowed(old, c))).toBe(true);
  });

  it("refuses anything outside a payment: cNGN pulled with transferFrom, approving another spender's token, CELO or other tokens", () => {
    const tf = toFunctionSelector("transferFrom(address,address,uint256)");
    const foreign = getAddress("0x765DE816845861e75A25fCA122bb6898B8B1282a"); // cUSD
    expect(allowed(perms, { to: TOKENS.CNGN, data: (tf + "00".repeat(96)) as Hex, label: "x" })).toBe(false);
    expect(allowed(perms, { to: TOKENS.CNGN, data: (toFunctionSelector("approve(address,uint256)") + "00".repeat(64)) as Hex, label: "x" })).toBe(false);
    expect(allowed(perms, { to: foreign, data: (toFunctionSelector("transfer(address,uint256)") + "00".repeat(64)) as Hex, label: "x" })).toBe(false);
    expect(allowed(perms, { to: WALLET, data: "0x", label: "x" })).toBe(false);
  });

  it("the weekly caps are exact in token units (both tokens have 6 decimals)", () => {
    expect(DECIMALS).toEqual({ USDT: 6, CNGN: 6 });
    const s = agentPermissions({ usdtPerWeek: 10.5, cngnPerWeek: 15_000, days: 1 }).spend;
    expect(s.find((x) => x.token === TOKENS.USDT)!.limit).toBe(10_500_000n);
    expect(s.find((x) => x.token === TOKENS.CNGN)!.limit).toBe(15_000_000_000n);
    expect(s.every((x) => x.period === "week")).toBe(true);
  });
});

// ---------- one payment, from the client's wallet to the freelancer's browser ----------

let rpc: Server | undefined;
let rpcUrl = "";
let logs: Record<string, unknown>[] = [];
const LATEST = Number(ANNOUNCEMENTS_FROM_BLOCK) + 50;

async function startRpc() {
  rpc = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const one = (m: { id: number; method: string; params: any[] }) => {
        let result: unknown = "0x0";
        if (m.method === "eth_blockNumber") result = toHex(LATEST);
        if (m.method === "eth_chainId") result = toHex(42220);
        if (m.method === "eth_getLogs") result = logs;
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

/** Turn the agent's announce call into the log Celo would emit for it. */
function logFor(call: Call, i: number) {
  const { args } = decodeFunctionData({ abi: ANNOUNCER_ABI, data: call.data });
  const [schemeId, stealthAddress, ephemeralPubKey, metadata] = args as [bigint, Address, Hex, Hex];
  const topics = encodeEventTopics({ abi: [ANNOUNCEMENT_EVENT], eventName: "Announcement", args: { schemeId, stealthAddress, caller: WALLET } });
  const data = encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [ephemeralPubKey, metadata]);
  return { address: ERC5564_ANNOUNCER.toLowerCase(), topics, data, blockNumber: toHex(LATEST - 1), transactionHash: pad(toHex(i), { size: 32 }), transactionIndex: "0x0", blockHash: pad(toHex(LATEST - 1), { size: 32 }), logIndex: toHex(i), removed: false };
}

describe("a payment arrives on the freelancer's side exactly as sent", () => {
  beforeEach(async () => {
    logs = [];
    await startRpc();
  });
  afterEach(() => rpc?.close());

  it("the amount, address and date the freelancer sees match what the client paid, kobo included", async () => {
    const amounts = [2_000, 150_000.5, 999_999.99, 1_000_000_000];
    const sent: { amount: number; to: Address }[] = [];
    for (const [i, amount] of amounts.entries()) {
      const { out, calls } = await payOnce(amount);
      expect(out.status).toBe("paid");
      const pay = calls.find((c) => c.label === "payout")!;
      const to = getAddress(decodeFunctionData({ abi: [{ type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }], data: pay.data }).args[0] as Address);
      sent.push({ amount, to });
      logs.push(logFor(calls.find((c) => c.label === "announce")!, i + 1));
    }
    const { found } = await scan({ rpcUrl, keys });
    expect(found.map((f) => f.amountNgn).sort((a, b) => a - b)).toEqual(amounts);
    for (const s of sent) {
      const f = found.find((x) => x.stealthAddress === s.to)!;
      expect(f, `payout to ${s.to}`).toBeDefined();
      expect(f.amountNgn).toBe(s.amount);
      expect(f.from).toBe(WALLET);
      expect(f.paidAt).toBe(new Date(1_795_300_000 * 1000).toISOString());
      // Only this freelancer's keys open the address the money went to.
      expect(privateKeyToAddress(stealthPrivateKey(keys.spendingPrivateKey, keys.viewingPrivateKey, f.ephemeralPublicKey))).toBe(s.to);
    }
  });

  it("another freelancer scanning the same chain sees none of it", async () => {
    const { calls } = await payOnce(50_000);
    logs = [logFor(calls.find((c) => c.label === "announce")!, 1)];
    expect((await scan({ rpcUrl, keys: generateMetaKeys() })).found).toEqual([]);
  });

  it("every payout goes to a different address, and nothing on-chain names the freelancer", async () => {
    const addrs = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { calls } = await payOnce(2_000 + i);
      const pay = calls.find((c) => c.label === "payout")!;
      addrs.add(pay.data.slice(10, 74));
      const all = calls.map((c) => c.data.toLowerCase()).join("");
      expect(all).not.toContain(Buffer.from("Ada Obi").toString("hex"));
    }
    expect(addrs.size).toBe(5);
  });

  it("the receipt keeps no personal details from the invoice", async () => {
    const wallet = new Wallet();
    const t = textile();
    const out = await payInvoice(
      enc({ invoiceId: "INV-77", freelancer: "Ada Obi", amountNgn: 20_000, description: "Logo design", email: "ada@example.com", phone: "+2348031234567", bank: "GTBank 0123456789", address: "12 Allen Avenue, Ikeja" }),
      { executor: wallet, textile: new TextileClient("https://textile.test/v2", "key", t.fn), reader: reader(), code: "celo_test", maxUsdt: 1_000_000, gasTopUpUsdt: 0.05 },
    );
    expect(out.status).toBe("paid");
    const file = store().list("receipts").find((n) => n.includes("INV-77"))!;
    const text = JSON.stringify(store().read(file, {}));
    for (const secret of ["ada@example.com", "2348031234567", "0123456789", "GTBank", "Allen Avenue", "Logo design", "Ada Obi"]) expect(text).not.toContain(secret);
    expect(text).toContain("INV-77");
  });
});

// ---------- what people actually type ----------

describe("invoice text sent to the AI reader", () => {
  const cases: [string, string][] = [
    ["email", "Pay me at ada.obi+work@mail.example.co.uk please"],
    ["phone, international", "Call +2348031234567"],
    ["phone, spaced", "Call +234 803 123 4567"],
    ["phone, dashed", "Call 0803-123-4567"],
    ["phone, local", "Call 08031234567"],
    ["account number", "GTBank account 0123456789"],
    ["account number, spaced", "Account: 0123 456 789"],
    ["BVN", "BVN 22123456789"],
    ["IBAN", "IBAN GB33BUKB20201555555555"],
    ["wallet address", "Send to 0x52908400098527886E0F7030069857D2E4169EE7"],
  ];
  for (const [what, text] of cases) {
    it(`hides a ${what}`, () => {
      const out = redact(text);
      const digits = out.replace(/\D/g, "");
      expect(digits.length, out).toBeLessThan(6);
      expect(out).not.toMatch(/@/);
    });
  }

  it("keeps what the reader needs: amounts, dates and invoice numbers", () => {
    const out = redact("Invoice INV-2026-014, 21 Nov 2026. Total ₦150,000.00 for 4 articles.");
    expect(out).toContain("INV-2026-014");
    expect(out).toContain("₦150,000.00");
    expect(out).toContain("21 Nov 2026");
  });
});

describe("matching the name on an invoice", () => {
  const list: Freelancer[] = [{ id: "ada", name: "Ada Obi", aliases: ["Adaeze Obi"], metaAddress: keys.metaAddress }];

  it("ignores letter case and extra spaces", () => {
    for (const n of ["Ada Obi", "ada obi", "  ADA OBI ", "Ada  Obi", "Ada\tObi", "adaeze   obi", "ada"]) expect(findFreelancer(list, n)?.id, n).toBe("ada");
  });

  it("does not match look-alike letters or partial names", () => {
    for (const n of ["Аda Obi" /* Cyrillic А */, "Ada Obi2", "Ada", "Obi", "Ada O."]) {
      if (n === "Ada") continue; // "ada" is the id, so it matches on purpose
      expect(findFreelancer(list, n), n).toBeUndefined();
    }
  });
});

describe("the agent's key limits, as typed into the form", () => {
  const agent = () => {
    store().write("client.json", { walletAddress: WALLET, activatedAt: "2026-11-20T09:00:00Z" });
    let granted: unknown = null;
    const a = createAgent({
      textile: { preview: async () => ({ takerPays: "69300000", feeAmount: "14000" }) } as unknown as TextileClient,
      textileKeyless: true,
      reader: { readContract: async () => 0n, getBalance: async () => 0n, getCode: async () => "0x" } as unknown as PublicClient,
      adminKey: () => ("0x" + "4c".repeat(32)) as Hex,
      hasAdminKey: () => true,
      attributionCode: () => "celo_test",
      maxInvoiceUsdt: 500,
      gasTopUpUsdt: 0.05,
      actions: {
        grant: async (l: unknown) => {
          granted = l;
          agentPermissions(l as never); // would throw on a limit the wallet can't encode
        },
      },
    });
    return { a, granted: () => granted };
  };

  it("accepts what the form shows: commas, a naira sign, decimals", async () => {
    const { a, granted } = agent();
    await a.dispatch("POST", "/session/grant", { usdtPerWeek: "200.50", cngnPerWeek: "₦300,000", days: "7" });
    expect(granted()).toMatchObject({ usdtPerWeek: 200.5, cngnPerWeek: 300_000, days: 7 });
  });

  for (const [what, body] of [
    ["hex", { usdtPerWeek: "0x10", cngnPerWeek: "300000", days: "7" }],
    ["an exponent", { usdtPerWeek: "1e30", cngnPerWeek: "300000", days: "7" }],
    ["a negative number", { usdtPerWeek: "10", cngnPerWeek: "-300000", days: "7" }],
    ["too many decimals", { usdtPerWeek: "10.1234567", cngnPerWeek: "300000", days: "7" }],
    ["part of a day", { usdtPerWeek: "10", cngnPerWeek: "300000", days: "0.5" }],
    ["an absurd cap", { usdtPerWeek: "10000000", cngnPerWeek: "300000", days: "7" }],
  ] as const) {
    it(`refuses ${what} with a clear message, and gives no key`, async () => {
      const { a, granted } = agent();
      await expect(a.dispatch("POST", "/session/grant", body as Record<string, unknown>)).rejects.toMatchObject({ status: 400 });
      expect(granted()).toBeNull();
    });
  }
});
