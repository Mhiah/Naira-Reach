// The Receive side, in the freelancer's own browser. Receiving keys are made and
// kept here; nothing about them is sent anywhere. Bundled into web/vendor/receive.js
// by `npm run build:web` so the site needs no build step to run.
import { createClient, formatUnits, getAddress, hexToBigInt, http, isAddress, size, slice, type Address, type Client, type Hex } from "viem";
import { getBlock, getBlockNumber, getLogs } from "viem/actions";
import { celo } from "viem/chains";
import { ANNOUNCEMENT_EVENT, ANNOUNCEMENTS_FROM_BLOCK, ERC5564_ANNOUNCER } from "../announcer.ts";
import { DECIMALS, EXPLORER_TX, TOKENS } from "../celo.ts";
import { movePayout, payoutAccount, payoutBalances } from "../move.ts";
import { generateMetaKeys, isMine, parseMetaAddress, SCHEME_ID, type MetaKeys, type StealthPayout } from "../stealth.ts";
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

/** Celo's public RPC answers log searches 5,000 blocks at a time. */
const SPAN = 5000n;

/**
 * Find this freelancer's payouts from Celo's ERC-5564 announcements alone: no
 * receipt needed. Every announcement is checked here, in the browser, with the
 * viewing key; nothing about the keys leaves it.
 */
export async function scan(a: { rpcUrl: string; keys: MetaKeys; from?: string | null; onProgress?: (done: number, total: number) => void }) {
  const c = client(a.rpcUrl);
  const { spendingPublicKey } = parseMetaAddress(a.keys.metaAddress);
  const latest = await getBlockNumber(c);
  let start = a.from ? BigInt(a.from) + 1n : ANNOUNCEMENTS_FROM_BLOCK;
  if (start < ANNOUNCEMENTS_FROM_BLOCK) start = ANNOUNCEMENTS_FROM_BLOCK;
  const ranges: [bigint, bigint][] = [];
  for (let b = start; b <= latest; b += SPAN) ranges.push([b, b + SPAN - 1n < latest ? b + SPAN - 1n : latest]);

  const found: OpenedPayout[] = [];
  let done = 0;
  const one = async ([fromBlock, toBlock]: [bigint, bigint]) => {
    const get = () => getLogs(c, { address: ERC5564_ANNOUNCER, event: ANNOUNCEMENT_EVENT, args: { schemeId: SCHEME_ID }, fromBlock, toBlock });
    const logs = await get().catch(get);
    for (const log of logs) {
      const { stealthAddress, ephemeralPubKey, metadata, caller } = log.args;
      if (!stealthAddress || !ephemeralPubKey || !metadata || size(metadata) < 1) continue;
      const p: StealthPayout = { stealthAddress: getAddress(stealthAddress), ephemeralPublicKey: ephemeralPubKey, viewTag: slice(metadata, 0, 1) };
      let mine = false;
      try {
        mine = isMine(p, spendingPublicKey, a.keys.viewingPrivateKey);
      } catch {
        // Anyone can announce; a malformed key is someone else's noise.
      }
      if (!mine) continue;
      // Metadata for a token payout: view tag, transfer selector, token, amount.
      const token = size(metadata) >= 57 ? getAddress(slice(metadata, 5, 25)) : null;
      const amount = size(metadata) >= 57 ? hexToBigInt(slice(metadata, 25, 57)) : 0n;
      const block = await getBlock(c, { blockNumber: log.blockNumber! }).catch(() => null);
      found.push({
        invoiceId: "Payout",
        amountNgn: token === TOKENS.CNGN ? Number(formatUnits(amount, DECIMALS.CNGN)) : 0,
        paidAt: block ? new Date(Number(block.timestamp) * 1000).toISOString() : null,
        from: caller ? getAddress(caller) : null,
        ...p,
        gasMoneyUsdt: 0,
        transactions: log.transactionHash ? [log.transactionHash] : [],
      });
    }
    a.onProgress?.(++done, ranges.length);
  };
  // A few searches at a time, so the public RPC isn't flooded.
  for (let i = 0; i < ranges.length; i += 4) await Promise.all(ranges.slice(i, i + 4).map(one));
  return { found, scannedTo: latest.toString() };
}

/** What a payout address holds now, in whole naira and USD₮. */
export async function balances(rpcUrl: string, address: Address) {
  const b = await payoutBalances(client(rpcUrl), address);
  return { cngn: Number(formatUnits(b.cngn, DECIMALS.CNGN)), cngnUnits: b.cngn.toString(), usdt: Number(formatUnits(b.usdt, DECIMALS.USDT)) };
}

/** Send the payout address's cNGN to `to`: all of it, or `amount` (base units, as a string). */
export async function move(a: { rpcUrl: string; keys: MetaKeys; payout: OpenedPayout; to: string; code?: string | null; amount?: string | null }) {
  if (!isAddress(a.to.trim())) throw new Error("That is not a wallet address. It starts with 0x and has 42 characters.");
  const r = await movePayout({
    payout: { stealthAddress: a.payout.stealthAddress, ephemeralPublicKey: a.payout.ephemeralPublicKey, viewTag: a.payout.viewTag },
    keys: a.keys,
    to: getAddress(a.to.trim()),
    reader: client(a.rpcUrl),
    rpcUrl: a.rpcUrl,
    code: a.code,
    ...(a.amount ? { amount: BigInt(a.amount) } : {}),
  });
  return { hash: r.hash, explorer: EXPLORER_TX(r.hash), amountNgn: Number(formatUnits(r.cngn, DECIMALS.CNGN)), to: r.to };
}

(globalThis as unknown as { NRReceive: unknown }).NRReceive = { newKeys, checkKeys, openReceipt, scan, balances, move, explorerTx: EXPLORER_TX };
