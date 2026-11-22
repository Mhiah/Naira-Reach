// "Move naira" against a simulated Celo node: the exact transaction the
// freelancer's browser would broadcast, decoded and checked field by field.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, decodeFunctionData, erc20Abi, getAddress, http, keccak256, recoverAddress, toHex, type Hex } from "viem";
import { celo } from "viem/chains";
import { parseTransaction, serializeTransaction } from "viem/celo";
import { TOKENS, USDT_FEE_CURRENCY } from "../src/celo.ts";
import { movePayout } from "../src/move.ts";
import { generateMetaKeys, newStealthAddress } from "../src/stealth.ts";
import { readTag } from "../src/tag.ts";

let server: Server;
let url = "";
let raw: Hex[] = [];
let cngnBalance = 2000_000000n;
let receiptStatus = "0x1";

beforeEach(async () => {
  raw = [];
  cngnBalance = 2000_000000n;
  receiptStatus = "0x1";
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const one = (m: { id: number; method: string; params: any[] }) => {
        const z = "0x" + "00".repeat(32);
        const r: Record<string, unknown> = {
          eth_chainId: toHex(42220),
          eth_getTransactionCount: "0x0",
          eth_gasPrice: toHex(25_000_000_000n),
          eth_maxPriorityFeePerGas: toHex(1_000_000_000n),
          eth_estimateGas: toHex(60_000n),
          eth_getBlockByNumber: { number: "0x1", hash: z, parentHash: z, timestamp: "0x1", baseFeePerGas: toHex(25_000_000_000n), nonce: "0x0000000000000000", sha3Uncles: z, logsBloom: "0x" + "00".repeat(256), transactionsRoot: z, stateRoot: z, receiptsRoot: z, miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x0", gasLimit: toHex(30_000_000n), gasUsed: "0x0", transactions: [], uncles: [] },
          eth_call: "0x" + cngnBalance.toString(16).padStart(64, "0"),
          eth_blockNumber: "0x10",
        };
        if (m.method === "eth_sendRawTransaction") {
          raw.push(m.params[0]);
          return { jsonrpc: "2.0", id: m.id, result: "0x" + "ee".repeat(32) };
        }
        if (m.method === "eth_getTransactionReceipt") {
          return { jsonrpc: "2.0", id: m.id, result: { transactionHash: m.params[0], blockHash: z, blockNumber: "0x10", transactionIndex: "0x0", from: "0x" + "00".repeat(20), to: TOKENS.CNGN, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [], logsBloom: "0x" + "00".repeat(256), status: receiptStatus, type: "0x7b", contractAddress: null } };
        }
        if (!(m.method in r)) return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method}` } };
        return { jsonrpc: "2.0", id: m.id, result: r[m.method] };
      };
      const parsed = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => server.close());

const keys = generateMetaKeys();
const reader = () => createClient({ chain: celo, transport: http(url) });
const MY_WALLET = getAddress("0x5555555555555555555555555555555555555555");

describe("moving a payout", () => {
  it("signs one Celo transaction from the payout address: all the cNGN to the wallet given, gas in USD₮, tagged", async () => {
    const payout = newStealthAddress(keys.metaAddress);
    const out = await movePayout({ payout, keys, to: MY_WALLET, reader: reader(), rpcUrl: url, code: "celo_d6a0b77183c8" });
    expect(out).toMatchObject({ from: payout.stealthAddress, to: MY_WALLET, cngn: 2000_000000n });
    expect(raw).toHaveLength(1);
    const tx = parseTransaction(raw[0]!) as any;
    expect(tx.type).toBe("cip64"); // Celo's fee-currency transaction
    expect(tx.chainId).toBe(42220);
    expect(getAddress(tx.feeCurrency)).toBe(getAddress(USDT_FEE_CURRENCY)); // gas paid in USD₮, no CELO needed
    expect(getAddress(tx.to)).toBe(getAddress(TOKENS.CNGN));
    expect(tx.value ?? 0n).toBe(0n);
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data })).toMatchObject({ functionName: "transfer", args: [MY_WALLET, 2000_000000n] });
    expect(readTag(tx.data)).toEqual(["celo_d6a0b77183c8"]);
    // Signed by the one-time key, so it really comes from the payout address.
    const { r, s, yParity, v, ...unsigned } = tx;
    const signer = await recoverAddress({ hash: keccak256(serializeTransaction(unsigned)), signature: { r, s, yParity } });
    expect(signer).toBe(payout.stealthAddress);
    void v;
  });

  it("refuses token contracts, the zero address, the payout address itself, and someone else's payout", async () => {
    const payout = newStealthAddress(keys.metaAddress);
    for (const to of [TOKENS.CNGN, TOKENS.USDT, USDT_FEE_CURRENCY]) {
      await expect(movePayout({ payout, keys, to, reader: reader(), rpcUrl: url })).rejects.toThrow(/token contract/);
    }
    await expect(movePayout({ payout, keys, to: "0x0000000000000000000000000000000000000000", reader: reader(), rpcUrl: url })).rejects.toThrow(/zero/);
    await expect(movePayout({ payout, keys, to: payout.stealthAddress, reader: reader(), rpcUrl: url })).rejects.toThrow(/payout address itself/);
    const someoneElses = newStealthAddress(generateMetaKeys().metaAddress);
    await expect(movePayout({ payout: someoneElses, keys, to: MY_WALLET, reader: reader(), rpcUrl: url })).rejects.toThrow(/not made to your receiving code/);
    expect(raw).toHaveLength(0);
  });

  it("says so when there's nothing to move, and when the transfer fails on-chain", async () => {
    cngnBalance = 0n;
    await expect(movePayout({ payout: newStealthAddress(keys.metaAddress), keys, to: MY_WALLET, reader: reader(), rpcUrl: url })).rejects.toThrow(/Nothing to move/);
    expect(raw).toHaveLength(0);
    cngnBalance = 5n;
    receiptStatus = "0x0";
    await expect(movePayout({ payout: newStealthAddress(keys.metaAddress), keys, to: MY_WALLET, reader: reader(), rpcUrl: url })).rejects.toThrow(/failed on-chain/);
  });
});
