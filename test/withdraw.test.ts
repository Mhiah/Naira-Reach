// Withdrawing from the client's own wallet: which addresses are refused, how amounts
// are read, what "Max" leaves behind, and what actually goes on-chain. The chain is a
// small fake JSON-RPC server, so the signed transaction can be taken apart and checked.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, getAddress, keccak256, parseUnits, toHex, type Hex, type PublicClient } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { parseTransaction } from "viem/celo";
import { createAgent } from "../src/agent.ts";
import { TEXTILE_REACTOR, TOKENS, USDT_FEE_CURRENCY } from "../src/celo.ts";
import { readTag } from "../src/tag.ts";
import type { TextileClient } from "../src/textile.ts";
import { checkDestination, parseAmount, withdraw } from "../src/withdraw.ts";
import { freshState } from "./helpers.ts";

const KEY = ("0x" + "4c".repeat(32)) as Hex;
const WALLET = privateKeyToAddress(KEY);
const TO = "0x1234567890abcdef1234567890abcdef12345678";

describe("where a withdrawal may go", () => {
  it("accepts an ordinary address, in any letter case, with spaces around it", () => {
    expect(checkDestination(`  ${TO.toUpperCase().replace("0X", "0x")} `, WALLET)).toBe(getAddress(TO));
  });

  for (const [what, to, msg] of [
    ["not an address", "hello", /isn't a Celo address/],
    ["too short", "0x1234", /isn't a Celo address/],
    ["the zero address", "0x" + "0".repeat(40), /zero/],
    ["the wallet itself", WALLET.toLowerCase(), /this wallet itself/],
    ["the USD₮ contract", TOKENS.USDT, /contract/],
    ["the cNGN contract", TOKENS.CNGN, /contract/],
    ["the USD₮ fee adapter", USDT_FEE_CURRENCY, /contract/],
    ["the Textile reactor", TEXTILE_REACTOR, /contract/],
  ] as const) {
    it(`refuses ${what}`, () => expect(() => checkDestination(to, WALLET)).toThrow(msg));
  }
});

describe("reading the amount", () => {
  it("reads whole numbers, decimals and thousands separators", () => {
    expect(parseAmount("5", "USDT")).toBe(5_000_000n);
    expect(parseAmount("2.5", "USDT")).toBe(2_500_000n);
    expect(parseAmount("1,000.25", "USDT")).toBe(1_000_250_000n);
    expect(parseAmount("0.1", "CELO")).toBe(10n ** 17n);
  });
  for (const bad of ["", "0", "0.000", "-1", "abc", "1e3", "1.2.3"]) {
    it(`refuses "${bad}"`, () => expect(() => parseAmount(bad, "USDT")).toThrow());
  }
  it("refuses more decimal places than the token has", () => {
    expect(() => parseAmount("1.1234567", "USDT")).toThrow(/decimal/);
    expect(() => parseAmount("1.123456", "USDT")).not.toThrow();
  });
});

// ---------- a fake Celo node ----------

let server: Server;
let rpcUrl = "";
let usdtBalance = 0n;
let celoBalance = 0n;
let sent: Hex[] = [];
let failReceipt = false;

beforeEach(async () => {
  freshState();
  sent = [];
  failReceipt = false;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const calls = JSON.parse(body);
      const one = (c: { id: number; method: string; params: unknown[] }) => {
        const r = (result: unknown) => ({ jsonrpc: "2.0", id: c.id, result });
        switch (c.method) {
          case "eth_chainId": return r("0xa4ec");
          case "eth_getTransactionCount": return r("0x7");
          case "eth_gasPrice": return r(toHex(25n * 10n ** 9n));
          case "eth_maxPriorityFeePerGas": return r(toHex(10n ** 9n));
          case "eth_estimateGas": return r(toHex(21_000n));
          case "eth_getBalance": return r(toHex(celoBalance));
          case "eth_getBlockByNumber": return r({ number: "0x10", baseFeePerGas: toHex(25n * 10n ** 9n), timestamp: "0x1", hash: "0x" + "ab".repeat(32), transactions: [] });
          case "eth_call": return r(toHex(usdtBalance, { size: 32 }));
          case "eth_sendRawTransaction": {
            const raw = c.params[0] as Hex;
            sent.push(raw);
            return r(keccak256(raw));
          }
          case "eth_getTransactionReceipt":
            return r({ status: failReceipt ? "0x0" : "0x1", transactionHash: keccak256(sent[sent.length - 1]!), blockNumber: "0x10", blockHash: "0x" + "ab".repeat(32), logs: [], gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1", from: WALLET, to: TO, transactionIndex: "0x0", logsBloom: "0x" + "0".repeat(512), type: "0x2", contractAddress: null });
          default: return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: c.method } };
        }
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(calls) ? calls.map(one) : one(calls)));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((ok) => server.close(() => ok())));

const usdtTransfer = (raw: Hex) => {
  const tx = parseTransaction(raw) as { to: Hex; data: Hex; feeCurrency?: Hex; value?: bigint };
  const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data.slice(0, 2 + 8 + 128) as Hex });
  return { tx, to: args[0] as Hex, value: args[1] as bigint };
};

describe("withdrawing USD₮", () => {
  it("sends the typed amount to the pasted address, pays gas in USD₮, and carries the tag", async () => {
    usdtBalance = parseUnits("7.50", 6);
    const r = await withdraw({ adminKey: KEY, rpcUrl, token: "USDT", to: TO, amount: "5", code: "celo_test" });
    expect(r).toMatchObject({ token: "USDT", amount: "5", to: getAddress(TO) });
    expect(sent).toHaveLength(1);
    const { tx, to, value } = usdtTransfer(sent[0]!);
    expect(getAddress(tx.to)).toBe(getAddress(TOKENS.USDT));
    expect(getAddress(tx.feeCurrency!)).toBe(getAddress(USDT_FEE_CURRENCY));
    expect(getAddress(to)).toBe(getAddress(TO));
    expect(value).toBe(5_000_000n);
    expect(readTag(tx.data)).toEqual(["celo_test"]);
  });

  it("Max keeps a few cents back for the network fee", async () => {
    usdtBalance = parseUnits("7.56", 6);
    const r = await withdraw({ adminKey: KEY, rpcUrl, token: "USDT", to: TO, amount: "max", code: "celo_test" });
    expect(r.amount).toBe("7.54");
    expect(usdtTransfer(sent[0]!).value).toBe(7_540_000n);
  });

  it("refuses more than the wallet has, before signing anything", async () => {
    usdtBalance = parseUnits("3", 6);
    await expect(withdraw({ adminKey: KEY, rpcUrl, token: "USDT", to: TO, amount: "3", code: "x" })).rejects.toThrow(/Not enough USD₮/);
    await expect(withdraw({ adminKey: KEY, rpcUrl, token: "USDT", to: TO, amount: "10", code: "x" })).rejects.toThrow(/Not enough USD₮/);
    expect(sent).toHaveLength(0);
  });

  it("Max with only dust left says so instead of sending nothing", async () => {
    usdtBalance = parseUnits("0.01", 6);
    await expect(withdraw({ adminKey: KEY, rpcUrl, token: "USDT", to: TO, amount: "Max" })).rejects.toThrow(/isn't enough USD₮/);
    expect(sent).toHaveLength(0);
  });

  it("reports a transfer that failed on-chain", async () => {
    usdtBalance = parseUnits("7", 6);
    failReceipt = true;
    await expect(withdraw({ adminKey: KEY, rpcUrl, token: "USDT", to: TO, amount: "1" })).rejects.toThrow(/failed on-chain/);
  });
});

describe("withdrawing CELO", () => {
  it("sends plain CELO, untagged, with the fee paid in CELO", async () => {
    celoBalance = parseUnits("3.16", 18);
    const r = await withdraw({ adminKey: KEY, rpcUrl, token: "CELO", to: TO, amount: "1.5", code: "celo_test" });
    expect(r.amount).toBe("1.5");
    const tx = parseTransaction(sent[0]!) as { to: Hex; value?: bigint; data?: Hex; feeCurrency?: Hex };
    expect(getAddress(tx.to)).toBe(getAddress(TO));
    expect(tx.value).toBe(parseUnits("1.5", 18));
    expect(tx.feeCurrency).toBeUndefined();
    expect(tx.data ?? "0x").toBe("0x");
  });

  it("Max leaves enough CELO for the fee", async () => {
    celoBalance = parseUnits("3.16", 18);
    await withdraw({ adminKey: KEY, rpcUrl, token: "CELO", to: TO, amount: "max" });
    const tx = parseTransaction(sent[0]!) as { value?: bigint; gas?: bigint; maxFeePerGas?: bigint };
    expect(tx.value! < celoBalance).toBe(true);
    expect(tx.value! + tx.gas! * tx.maxFeePerGas!).toBeLessThanOrEqual(celoBalance);
  });

  it("refuses more CELO than the wallet has", async () => {
    celoBalance = parseUnits("1", 18);
    await expect(withdraw({ adminKey: KEY, rpcUrl, token: "CELO", to: TO, amount: "1" })).rejects.toThrow(/Not enough CELO/);
    expect(sent).toHaveLength(0);
  });
});

describe("the website's withdraw request", () => {
  const agent = (opts: { hasKey?: boolean } = {}) => {
    const calls: unknown[] = [];
    const a = createAgent({
      textile: {} as TextileClient,
      textileKeyless: true,
      reader: { readContract: async () => 0n, getBalance: async () => 0n, getCode: async () => "0x" } as unknown as PublicClient,
      rpcUrl: "http://127.0.0.1:1",
      adminKey: () => KEY,
      hasAdminKey: () => opts.hasKey ?? true,
      attributionCode: () => "celo_test",
      maxInvoiceUsdt: 500,
      gasTopUpUsdt: 0.05,
      actions: {
        withdraw: async (w) => {
          calls.push(w);
          return { token: w.token, amount: "5", to: getAddress(w.to), hash: "0xabc" as Hex };
        },
      },
    });
    return { a, calls };
  };

  it("passes a good request through to the wallet", async () => {
    const { a, calls } = agent();
    const r = await a.dispatch("POST", "/wallet/withdraw", { token: "USDT", to: TO, amount: "5" });
    expect(r).toMatchObject({ token: "USDT", amount: "5" });
    expect(calls).toEqual([{ token: "USDT", to: TO, amount: "5" }]);
  });

  for (const [what, body, msg] of [
    ["an unknown token", { token: "cNGN", to: TO, amount: "5" }, /USD₮ or CELO/],
    ["a bad address", { token: "USDT", to: "0x12", amount: "5" }, /Celo address/],
    ["the zero address", { token: "USDT", to: "0x" + "0".repeat(40), amount: "5" }, /zero/],
    ["a token contract", { token: "CELO", to: TOKENS.USDT, amount: "1" }, /contract/],
    ["no amount", { token: "USDT", to: TO, amount: "" }, /number/],
    ["a negative amount", { token: "USDT", to: TO, amount: "-5" }, /number/],
  ] as const) {
    it(`refuses ${what} without touching the wallet`, async () => {
      const { a, calls } = agent();
      await expect(a.dispatch("POST", "/wallet/withdraw", body)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(msg) });
      expect(calls).toHaveLength(0);
    });
  }

  it("needs the wallet key here: the agent's key alone can't withdraw", async () => {
    const { a, calls } = agent({ hasKey: false });
    await expect(a.dispatch("POST", "/wallet/withdraw", { token: "USDT", to: TO, amount: "5" })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});
