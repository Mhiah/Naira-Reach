// The Receive side, in the freelancer's own browser. Receiving keys are made and
// kept here; nothing about them is sent anywhere. Bundled into web/vendor/receive.js
// by `npm run build:web` so the site needs no build step to run.
import { createClient, formatUnits, getAddress, http, isAddress, type Address, type Client, type Hex } from "viem";
import { celo } from "viem/chains";
import { DECIMALS, EXPLORER_TX } from "../celo.ts";
import { movePayout, payoutAccount, payoutBalances } from "../move.ts";
import { generateMetaKeys, parseMetaAddress, type MetaKeys, type StealthPayout } from "../stealth.ts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "viem";

type Receipt = {
  product?: string;
  paidAt?: string;
  invoice?: { invoiceId?: string; amountNgn?: number };
  payout?: StealthPayout & { cngn?: number; gasMoneyUsdt?: number };
  wallet?: { address?: Address };
  transactions?: { hash: Hex }[];
};

export type OpenedPayout = {
  invoiceId: string;
  amountNgn: number;
  paidAt: string | null;
  from: Address | null;
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag: Hex;
  gasMoneyUsdt: number;
  transactions: string[];
};

const client = (rpcUrl: string): Client => createClient({ chain: celo, transport: http(rpcUrl) });
const pubOf = (priv: Hex) => bytesToHex(secp256k1.getPublicKey(hexToBytes(priv), true));

/** Make a new pair of receiving keys. */
export function newKeys(): MetaKeys {
  return generateMetaKeys();
}

/** Check a restored backup really is a matching set of keys. */
export function checkKeys(raw: unknown): MetaKeys {
  const k = raw as Partial<MetaKeys> | null;
  if (!k || typeof k.spendingPrivateKey !== "string" || typeof k.viewingPrivateKey !== "string" || typeof k.metaAddress !== "string") {
    throw new Error("That file is not a Naira Reach key backup.");
  }
  const { spendingPublicKey, viewingPublicKey } = parseMetaAddress(k.metaAddress);
  if (pubOf(k.spendingPrivateKey as Hex) !== spendingPublicKey.toLowerCase() || pubOf(k.viewingPrivateKey as Hex) !== viewingPublicKey.toLowerCase()) {
    throw new Error("The keys in that backup don't match its receiving code.");
  }
  return { spendingPrivateKey: k.spendingPrivateKey, viewingPrivateKey: k.viewingPrivateKey, metaAddress: k.metaAddress };
}

/** Read a receipt from the client and confirm the payout is ours. */
export function openReceipt(raw: unknown, keys: MetaKeys): OpenedPayout {
  const r = raw as Receipt | null;
  const p = r?.payout;
  if (!p || typeof p.stealthAddress !== "string" || typeof p.ephemeralPublicKey !== "string" || typeof p.viewTag !== "string") {
    throw new Error("That file is not a Naira Reach receipt.");
  }
  if (!isAddress(p.stealthAddress)) throw new Error("The receipt's payout address is not valid.");
  const payout = { stealthAddress: getAddress(p.stealthAddress), ephemeralPublicKey: p.ephemeralPublicKey, viewTag: p.viewTag };
  payoutAccount(payout, keys); // throws if it isn't ours
  return {
    invoiceId: String(r?.invoice?.invoiceId ?? "Payout"),
    amountNgn: Number(r?.invoice?.amountNgn ?? p.cngn ?? 0),
    paidAt: r?.paidAt ?? null,
    from: r?.wallet?.address && isAddress(r.wallet.address) ? getAddress(r.wallet.address) : null,
    ...payout,
    gasMoneyUsdt: Number(p.gasMoneyUsdt ?? 0),
    transactions: (r?.transactions ?? []).map((t) => t.hash),
  };
}

/** What a payout address holds now, in whole naira and USD₮. */
export async function balances(rpcUrl: string, address: Address) {
  const b = await payoutBalances(client(rpcUrl), address);
  return { cngn: Number(formatUnits(b.cngn, DECIMALS.CNGN)), usdt: Number(formatUnits(b.usdt, DECIMALS.USDT)) };
}

/** Send everything in the payout address to `to`. */
export async function move(a: { rpcUrl: string; keys: MetaKeys; payout: OpenedPayout; to: string; code?: string | null }) {
  if (!isAddress(a.to.trim())) throw new Error("That is not a wallet address. It starts with 0x and has 42 characters.");
  const r = await movePayout({
    payout: { stealthAddress: a.payout.stealthAddress, ephemeralPublicKey: a.payout.ephemeralPublicKey, viewTag: a.payout.viewTag },
    keys: a.keys,
    to: getAddress(a.to.trim()),
    reader: client(a.rpcUrl),
    rpcUrl: a.rpcUrl,
    code: a.code,
  });
  return { hash: r.hash, explorer: EXPLORER_TX(r.hash), amountNgn: Number(formatUnits(r.cngn, DECIMALS.CNGN)), to: r.to };
}

(globalThis as unknown as { NRReceive: unknown }).NRReceive = { newKeys, checkKeys, openReceipt, balances, move, explorerTx: EXPLORER_TX };
