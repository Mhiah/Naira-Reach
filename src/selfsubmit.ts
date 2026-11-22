// Your wallet sends the Altana payment itself, instead of Altana's relayer.
//
// Loops House only counts a transaction that the agent wallet itself sends, with
// the attribution tag at the end of its data. Through Altana, the relayer sends
// the outer transaction, so it never counts.
//
// Altana's Orchestrator (Ithaca's, v0.5.5) lets anyone submit a signed intent.
// So the payment is prepared and signed exactly as before, by the agent's
// limited session key, but at the moment it would be handed to the relay
// (`wallet_sendPreparedCalls`) we encode the signed intent and send
// `Orchestrator.execute(intent)` from the wallet ourselves, tag on the end, gas in
// USD₮. The session key, its caps and its allowlist still decide what runs. The
// relay's own fee in the intent is still paid to the relay.
//
// The swap happens at the JSON-RPC level, by wrapping fetch for the relay's URL
// while one payment runs, so the Altana SDK is used unchanged.
import {
  createClient,
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { call, estimateGas, getTransactionReceipt, sendTransaction } from "viem/actions";
import { celo } from "viem/chains";
import * as Key from "porto/viem/Key";
import { USDT_FEE_CURRENCY } from "./celo.ts";
import { tagCalldata } from "./tag.ts";

/** ICommon.Intent of Ithaca account v0.5.5, field for field, in order. */
const INTENT_TUPLE = {
  type: "tuple",
  components: [
    { name: "eoa", type: "address" },
    { name: "executionData", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "payer", type: "address" },
    { name: "paymentToken", type: "address" },
    { name: "paymentMaxAmount", type: "uint256" },
    { name: "combinedGas", type: "uint256" },
    { name: "encodedPreCalls", type: "bytes[]" },
    { name: "encodedFundTransfers", type: "bytes[]" },
    { name: "settler", type: "address" },
    { name: "expiry", type: "uint256" },
    { name: "isMultichain", type: "bool" },
    { name: "funder", type: "address" },
    { name: "funderSignature", type: "bytes" },
    { name: "settlerContext", type: "bytes" },
    { name: "paymentAmount", type: "uint256" },
    { name: "paymentRecipient", type: "address" },
    { name: "signature", type: "bytes" },
    { name: "paymentSignature", type: "bytes" },
    { name: "supportedAccountImplementation", type: "address" },
  ],
} as const;

export const ORCHESTRATOR_ABI = parseAbi([
  "function execute(bytes encodedIntent) payable returns (bytes4 err)",
  "event IntentExecuted(address indexed eoa, uint256 indexed nonce, bool incremented, bytes4 err)",
]);

/** Intent as the relay returns it in a prepared quote: numbers as hex or decimal strings. */
export type RelayIntent = Record<string, unknown>;
/** The key that signed, as Porto hands it to the relay (`Key.toRelay`). */
export type RelayKey = { type: string; publicKey: Hex; prehash?: boolean } | undefined;

const big = (v: unknown) => (v === undefined || v === null || v === "" ? 0n : BigInt(v as string | number | bigint));
const addr = (v: unknown) => (v ? getAddress(v as string) : ("0x0000000000000000000000000000000000000000" as Address));
const bytes = (v: unknown) => ((v as Hex) || "0x") as Hex;

/**
 * The signature the account checks. A 64/65-byte signature is read as the wallet's own
 * (admin) key; any other key's signature is wrapped with its key hash, as the relay does.
 */
export function intentSignature(signature: Hex, key: RelayKey): Hex {
  if (!key) return signature;
  return Key.wrapSignature(signature, { keyType: key.type as never, publicKey: key.publicKey, prehash: Boolean(key.prehash) }) as Hex;
}

/** `abi.encode(intent)`, with the signature filled in: what Orchestrator.execute takes. */
export function encodeIntent(intent: RelayIntent, signature: Hex): Hex {
  const i = intent;
  return encodeAbiParameters(
    [INTENT_TUPLE],
    [
      {
        eoa: addr(i.eoa),
        executionData: bytes(i.executionData),
        nonce: big(i.nonce),
        payer: addr(i.payer),
        paymentToken: addr(i.paymentToken),
        paymentMaxAmount: big(i.paymentMaxAmount),
        combinedGas: big(i.combinedGas),
        encodedPreCalls: ((i.encodedPreCalls as Hex[]) ?? []).map(bytes),
        encodedFundTransfers: ((i.encodedFundTransfers as Hex[]) ?? []).map(bytes),
        settler: addr(i.settler),
        expiry: big(i.expiry),
        isMultichain: Boolean(i.isMultichain),
        funder: addr(i.funder),
        funderSignature: bytes(i.funderSignature),
        settlerContext: bytes(i.settlerContext),
        paymentAmount: big(i.paymentAmount),
        paymentRecipient: addr(i.paymentRecipient),
        signature,
        paymentSignature: bytes(i.paymentSignature),
        supportedAccountImplementation: addr(i.supportedAccountImplementation),
      },
    ],
  );
}

/** The transaction the wallet sends: Orchestrator.execute(intent), tagged. */
export function selfSubmitData(intent: RelayIntent, signature: Hex, key: RelayKey, code: string): Hex {
  const data = encodeFunctionData({ abi: ORCHESTRATOR_ABI, functionName: "execute", args: [encodeIntent(intent, intentSignature(signature, key))] });
  return tagCalldata(data, code);
}

export type SelfSubmitDeps = {
  /** The wallet's own key: it signs and pays for the outer transaction. */
  adminKey: Hex;
  rpcUrl: string;
  /** Attribution code for the end of the outer transaction. */
  code: string;
  relayUrl: string;
  log?: (line: string) => void;
};

/**
 * Gas for the outer transaction. execute() doesn't revert when it's short of gas, it
 * returns an error, so an estimate alone can come out too low. Enough for the intent's
 * own budget (combinedGas plus the Orchestrator's 100,000 overhead, under the 63/64 rule),
 * and at least what the relay itself would have used.
 */
export function txGas(estimate: bigint, intent: RelayIntent, relayTxGas?: unknown): bigint {
  const forIntent = ((big(intent.combinedGas) + 100_000n) * 64n) / 63n + 150_000n;
  const relay = (big(relayTxGas) * 12n) / 10n;
  const est = (estimate * 13n) / 10n;
  return [forIntent, relay, est].reduce((a, b) => (b > a ? b : a));
}

type Pending = { hash: Hex; eoa: Address; nonce: bigint; chainId: number };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const NO_ERROR = "0x00000000";

/**
 * A fetch that hands everything to `inner`, except the two relay calls that send
 * and track a prepared intent: those are done from the wallet instead.
 */
export function selfSubmitFetch(deps: SelfSubmitDeps, inner: typeof fetch): typeof fetch {
  const pending = new Map<string, Pending>();
  const account = privateKeyToAccount(deps.adminKey);
  const chain = createClient({ account, chain: celo, transport: http(deps.rpcUrl) });
  const relay = deps.relayUrl.replace(/\/+$/, "");

  async function send(id: unknown, p: { context?: { quote?: { quotes?: { intent?: RelayIntent; orchestrator?: string; chainId?: unknown; txGas?: unknown }[] } }; signature?: Hex; key?: RelayKey }) {
    const q = p.context?.quote?.quotes?.[0];
    if (!q?.intent || !q.orchestrator || !p.signature) throw new Error("The relay's prepared payment had no intent to send.");
    const orchestrator = getAddress(q.orchestrator);
    const eoa = getAddress(String(q.intent.eoa));
    if (eoa !== account.address) throw new Error("This payment is for a different wallet than the one sending it.");
    const data = selfSubmitData(q.intent, p.signature, p.key, deps.code);
    // Check first, for free: execute() reports problems by returning an error code, not by reverting.
    const sim = await call(chain, { account, to: orchestrator, data });
    const err = sim.data ? decodeFunctionResult({ abi: ORCHESTRATOR_ABI, functionName: "execute", data: sim.data }) : NO_ERROR;
    if (err !== NO_ERROR) throw new Error(`The payment would fail (Orchestrator error ${err}). Nothing was sent.`);
    const gas = txGas(await estimateGas(chain, { account, to: orchestrator, data }), q.intent, q.txGas);
    const hash = await sendTransaction(chain, { account, chain: celo, to: orchestrator, data, gas, feeCurrency: USDT_FEE_CURRENCY });
    deps.log?.(`Sent from your wallet: ${hash}`);
    pending.set(hash, { hash, eoa, nonce: big(q.intent.nonce), chainId: Number(big(q.chainId) || BigInt(celo.id)) });
    return json({ jsonrpc: "2.0", id, result: { id: hash } });
  }

  async function status(id: unknown, callsId: string) {
    const p = pending.get(callsId)!;
    const r = await getTransactionReceipt(chain, { hash: p.hash }).catch(() => null);
    if (!r) return json({ jsonrpc: "2.0", id, result: { id: callsId, status: 100 } });
    let ok = r.status === "success";
    for (const log of r.logs) {
      try {
        const ev = decodeEventLog({ abi: ORCHESTRATOR_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === "IntentExecuted" && getAddress(ev.args.eoa) === p.eoa && ev.args.nonce === p.nonce) ok = ok && ev.args.err === NO_ERROR;
      } catch {
        // Other contracts' events.
      }
    }
    const toHex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        id: callsId,
        status: ok ? 200 : 500,
        receipts: [
          {
            blockHash: r.blockHash,
            blockNumber: toHex(r.blockNumber),
            chainId: toHex(p.chainId),
            gasUsed: toHex(r.gasUsed),
            logs: r.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics })),
            status: ok ? "0x1" : "0x0",
            transactionHash: r.transactionHash,
          },
        ],
      },
    });
  }

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.replace(/\/+$/, "") !== relay || !init?.body || typeof init.body !== "string") return inner(input as never, init);
    let msg: { id?: unknown; method?: string; params?: unknown[] };
    try {
      msg = JSON.parse(init.body);
    } catch {
      return inner(input as never, init);
    }
    try {
      if (msg.method === "wallet_sendPreparedCalls") return await send(msg.id, (msg.params?.[0] ?? {}) as never);
      if (msg.method === "wallet_getCallsStatus" && pending.has(String(msg.params?.[0]))) return await status(msg.id, String(msg.params?.[0]));
    } catch (e) {
      return json({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: (e as Error).message } });
    }
    return inner(input as never, init);
  }) as typeof fetch;
}

/** Run `fn` with relay sends going out from the wallet itself. One payment at a time. */
export async function withSelfSubmit<T>(deps: SelfSubmitDeps, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = selfSubmitFetch(deps, original.bind(globalThis));
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}
