// The wallet sending its own Altana payment: the intent the agent's key signed, encoded
// exactly as Altana's relayer encodes it, sent from the wallet with the tag on the end.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, keccak256, recoverAddress, size, slice, toHex, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { parseTransaction, serializeTransaction } from "viem/celo";
import * as Key from "porto/viem/Key";
import { USDT_FEE_CURRENCY } from "../src/celo.ts";
import { encodeIntent, intentSignature, ORCHESTRATOR_ABI, selfSubmitFetch, type RelayIntent } from "../src/selfsubmit.ts";
import { readTag } from "../src/tag.ts";

const ADMIN = ("0x" + "4c".repeat(32)) as Hex;
const WALLET = privateKeyToAddress(ADMIN);
const ORCH = getAddress("0xaf140d0416a994aebb3fa6212b16ce6700f09751");
const RELAY = "https://relay.example";
const SESSION_PUB = getAddress("0x1111111111111111111111111111111111111111");
const SIG = ("0x" + "ab".repeat(64) + "1b") as Hex;

const intent = (o: Partial<RelayIntent> = {}): RelayIntent => ({
  eoa: WALLET,
  executionData: "0x1234",
  nonce: "0xa17acb52222738b0d4a12b9e2019ad7856d6285ea4b3a068000000000000000",
  payer: "0x0000000000000000000000000000000000000000",
  paymentToken: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
  paymentMaxAmount: "0x4b04",
  combinedGas: "0x7da2a",
  encodedPreCalls: [],
  encodedFundTransfers: [],
  settler: "0x0000000000000000000000000000000000000000",
  expiry: "0x0",
  isMultichain: false,
  funder: "0x0000000000000000000000000000000000000000",
  funderSignature: "0x",
  settlerContext: "0x",
  paymentAmount: "0x22a",
  paymentRecipient: "0xaf089b4eca94a4b2f51d8f5668cff244f2c6c4bc",
  signature: "0x",
  paymentSignature: "0x",
  supportedAccountImplementation: "0x4b5d20cd8a3927b500540d9bccddc27385c9fa79",
  ...o,
});

describe("encoding the signed payment", () => {
  it("lays out the intent in the Orchestrator's field order, as on Altana's real payment", () => {
    // The head of the ₦2,000 payment's intent, copied from its transaction on Celo:
    // eoa, executionData offset 0x280, nonce, payer, paymentToken, max amount, gas …
    const enc = encodeIntent(intent(), SIG);
    const word = (n: number) => slice(enc, 32 + n * 32, 64 + n * 32);
    expect(BigInt(slice(enc, 0, 32))).toBe(32n); // abi.encode of a dynamic struct starts with its offset
    expect(getAddress(slice(word(0), 12))).toBe(WALLET);
    expect(BigInt(word(1))).toBe(0x280n);
    expect(word(2)).toBe("0xa17acb52222738b0d4a12b9e2019ad7856d6285ea4b3a068000000000000000".replace("0x", "0x0") as Hex);
    expect(getAddress(slice(word(4), 12))).toBe(getAddress("0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"));
    expect(BigInt(word(5))).toBe(0x4b04n);
    expect(BigInt(word(6))).toBe(0x7da2an);
    expect(BigInt(word(15))).toBe(0x22an);
    expect(getAddress(slice(word(16), 12))).toBe(getAddress("0xaf089b4eca94a4b2f51d8f5668cff244f2c6c4bc"));
    expect(getAddress(slice(word(19), 12))).toBe(getAddress("0x4b5d20cd8a3927b500540d9bccddc27385c9fa79"));
  });

  it("wraps a session key's signature with its key hash, and leaves the wallet's own signature as it is", () => {
    const key = { type: "secp256k1", publicKey: SESSION_PUB, prehash: false };
    const wrapped = intentSignature(SIG, key);
    expect(size(wrapped)).toBe(98); // 65 + 32-byte key hash + 1 prehash flag, as on the real payment
    expect(slice(wrapped, 0, 65)).toBe(SIG);
    expect(slice(wrapped, 65, 97)).toBe(Key.hash({ type: "secp256k1", publicKey: SESSION_PUB } as never));
    expect(slice(wrapped, 97)).toBe("0x00");
    expect(intentSignature(SIG, undefined)).toBe(SIG);
  });
});

// ---------- a simulated Celo node ----------

let server: Server;
let rpcUrl = "";
let raw: Hex[] = [];
let simErr: Hex = "0x00000000";
let eventErr: Hex = "0x00000000";
let mined = true;
let lastNonce = 0n;

beforeEach(async () => {
  raw = [];
  simErr = "0x00000000";
  eventErr = "0x00000000";
  mined = true;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const z = "0x" + "00".repeat(32);
      const one = (m: { id: number; method: string; params: any[] }) => {
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
        if (m.method === "eth_chainId") return ok(toHex(42220));
        if (m.method === "eth_getTransactionCount") return ok("0x7");
        if (m.method === "eth_gasPrice") return ok(toHex(25_000_000_000n));
        if (m.method === "eth_maxPriorityFeePerGas") return ok(toHex(1_000_000_000n));
        if (m.method === "eth_estimateGas") return ok(toHex(600_000n));
        if (m.method === "eth_blockNumber") return ok("0x10");
        if (m.method === "eth_call") return ok(encodeAbiParameters([{ type: "bytes4" }], [simErr]));
        if (m.method === "eth_getBlockByNumber") return ok({ number: "0x1", hash: z, parentHash: z, timestamp: "0x1", baseFeePerGas: toHex(25_000_000_000n), nonce: "0x0000000000000000", sha3Uncles: z, logsBloom: "0x" + "00".repeat(256), transactionsRoot: z, stateRoot: z, receiptsRoot: z, miner: "0x" + "00".repeat(20), difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x0", gasLimit: toHex(30_000_000n), gasUsed: "0x0", transactions: [], uncles: [] });
        if (m.method === "eth_sendRawTransaction") {
          raw.push(m.params[0]);
          return ok(keccak256(m.params[0]));
        }
        if (m.method === "eth_getTransactionReceipt") {
          if (!mined) return ok(null);
          const topics = encodeEventTopics({ abi: ORCHESTRATOR_ABI, eventName: "IntentExecuted", args: { eoa: WALLET, nonce: lastNonce } });
          const data = encodeAbiParameters([{ type: "bool" }, { type: "bytes4" }], [true, eventErr]);
          return ok({ transactionHash: m.params[0], blockHash: z, blockNumber: "0x10", transactionIndex: "0x0", from: WALLET, to: ORCH, cumulativeGasUsed: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x1", logs: [{ address: ORCH, topics, data, blockHash: z, blockNumber: "0x10", transactionHash: m.params[0], transactionIndex: "0x0", logIndex: "0x0", removed: false }], logsBloom: "0x" + "00".repeat(256), status: "0x1", type: "0x7b", contractAddress: null });
        }
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method}` } };
      };
      const parsed = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => server.close());

function relayFetch() {
  const passed: string[] = [];
  const inner = (async (input: string | URL | Request, init?: RequestInit) => {
    passed.push(`${String(input)} ${init?.body ? JSON.parse(String(init.body)).method : ""}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "from the relay" }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const f = selfSubmitFetch({ adminKey: ADMIN, rpcUrl, code: "celo_d6a0b77183c8", relayUrl: RELAY }, inner);
  const rpc = async (method: string, params: unknown[]) => (await (await f(RELAY, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 9, method, params }) })).json()) as { result?: any; error?: { message: string } };
  return { f, rpc, passed };
}

const prepared = (o: Partial<RelayIntent> = {}) => {
  const i = intent(o);
  lastNonce = BigInt(String(i.nonce));
  return { context: { quote: { quotes: [{ intent: i, orchestrator: ORCH, chainId: "0xa4ec" }] } }, signature: SIG, key: { type: "secp256k1", publicKey: SESSION_PUB, prehash: false } };
};

describe("the wallet sends the signed payment itself", () => {
  it("sends Orchestrator.execute from the wallet, tagged at the end, gas in USD₮, with the session's signature inside", async () => {
    const { rpc } = relayFetch();
    const sent = await rpc("wallet_sendPreparedCalls", [prepared()]);
    expect(sent.error).toBeUndefined();
    expect(raw).toHaveLength(1);
    const tx = parseTransaction(raw[0]!) as any;
    expect(sent.result.id).toBe(keccak256(raw[0]!));
    expect(tx.type).toBe("cip64");
    expect(tx.chainId).toBe(42220);
    expect(getAddress(tx.to)).toBe(ORCH);
    expect(getAddress(tx.feeCurrency)).toBe(getAddress(USDT_FEE_CURRENCY));
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.gas).toBe(780_000n); // the larger of the estimate plus 30% and the intent's own budget
    // Signed by the wallet's own key, so Loops sees the agent wallet as the sender.
    const { r, s, yParity, v, ...unsigned } = tx;
    expect(await recoverAddress({ hash: keccak256(serializeTransaction(unsigned)), signature: { r, s, yParity } })).toBe(WALLET);
    // The tag is the last thing in the data.
    expect(readTag(tx.data)).toEqual(["celo_d6a0b77183c8"]);
    // Inside: exactly the intent the relay prepared, carrying the session key's wrapped signature.
    const { args } = decodeFunctionData({ abi: ORCHESTRATOR_ABI, data: tx.data });
    expect(args[0]).toBe(encodeIntent(intent(), intentSignature(SIG, prepared().key)));
  });

  it("reports the payment as confirmed once the Orchestrator says it ran, and failed when it didn't", async () => {
    const { rpc } = relayFetch();
    mined = false;
    const { result } = await rpc("wallet_sendPreparedCalls", [prepared()]);
    expect((await rpc("wallet_getCallsStatus", [result.id])).result).toMatchObject({ id: result.id, status: 100 });
    mined = true;
    const done = (await rpc("wallet_getCallsStatus", [result.id])).result;
    expect(done.status).toBe(200);
    expect(done.receipts[0]).toMatchObject({ transactionHash: result.id, status: "0x1", chainId: "0xa4ec" });
    eventErr = "0xd0e2c31e"; // the intent's calls reverted inside a mined transaction
    expect((await rpc("wallet_getCallsStatus", [result.id])).result.status).toBe(500);
  });

  it("checks first, for free, and sends nothing when the Orchestrator would refuse", async () => {
    const { rpc } = relayFetch();
    simErr = "0xfa103f5d";
    const out = await rpc("wallet_sendPreparedCalls", [prepared()]);
    expect(out.error?.message).toMatch(/would fail.*Nothing was sent/);
    expect(raw).toHaveLength(0);
  });

  it("refuses a payment prepared for a different wallet", async () => {
    const { rpc } = relayFetch();
    const out = await rpc("wallet_sendPreparedCalls", [prepared({ eoa: "0x2222222222222222222222222222222222222222" })]);
    expect(out.error?.message).toMatch(/different wallet/);
    expect(raw).toHaveLength(0);
  });

  it("leaves every other relay call, and every other site, to the relay as before", async () => {
    const { f, rpc, passed } = relayFetch();
    expect((await rpc("wallet_prepareCalls", [{}])).result).toBe("from the relay");
    expect((await rpc("wallet_getCallsStatus", ["0x" + "12".repeat(32)])).result).toBe("from the relay"); // not one of ours
    await f("https://forno.celo.org", { method: "POST", body: JSON.stringify({ method: "eth_chainId" }) });
    expect(passed).toEqual([`${RELAY} wallet_prepareCalls`, `${RELAY} wallet_getCallsStatus`, "https://forno.celo.org eth_chainId"]);
    expect(raw).toHaveLength(0);
  });
});

describe("gas for the outer transaction", () => {
  it("is never below the intent's own budget, the relay's figure, or the estimate", async () => {
    const { txGas } = await import("../src/selfsubmit.ts");
    const budget = ((0x7da2an + 100_000n) * 64n) / 63n + 150_000n;
    expect(txGas(21_000n, intent())).toBe(budget); // an estimate taken on the error path would be far too low
    expect(txGas(21_000n, intent(), "0x100000")).toBe((0x100000n * 12n) / 10n);
    expect(txGas(2_000_000n, intent())).toBe(2_600_000n);
  });
});

describe("what the Altana SDK reads back", () => {
  it("Porto's own status check accepts our answer and sees the transaction confirmed", async () => {
    const { createClient, http } = await import("viem");
    const { celo } = await import("viem/chains");
    const { getCallsStatus } = await import("porto/viem/RelayActions");
    const { f, rpc } = relayFetch();
    const client = createClient({ chain: celo, transport: http(RELAY, { fetchFn: f }) });
    // On the wire Porto sends numbers as hex, the way the prepared quote is written above.
    const id = (await rpc("wallet_sendPreparedCalls", [prepared()])).result.id as Hex;
    expect(raw).toHaveLength(1);
    const status = (await getCallsStatus(client as never, { id })) as { status: number; receipts?: { transactionHash: Hex }[] };
    expect(status.status).toBe(200);
    expect(status.receipts?.[0]?.transactionHash).toBe(id);
  });
});
