// The freelancer's side on the command line: make receiving keys once, then open
// a private payout and move the naira wherever they like (their own wallet, or an
// exchange deposit address to cash out). The website does the same in the browser.
import type { Address, PublicClient } from "viem";
import { readJson, statePath, writeJson } from "./config.ts";
import { movePayout } from "./move.ts";
import { generateMetaKeys, type MetaKeys, type StealthPayout } from "./stealth.ts";

const KEYS_FILE = () => statePath("freelancer-keys.json");

export function createFreelancerKeys(): MetaKeys {
  const existing = readJson<MetaKeys | null>(KEYS_FILE(), null);
  if (existing) return existing;
  const keys = generateMetaKeys();
  writeJson(KEYS_FILE(), keys, true);
  return keys;
}

export function loadFreelancerKeys(): MetaKeys {
  const keys = readJson<MetaKeys | null>(KEYS_FILE(), null);
  if (!keys) throw new Error("No receiving keys on this device. Run `npm run reach -- freelancer keys` first.");
  return keys;
}

export async function claimPayout(args: {
  receipt: { payout: StealthPayout };
  to: Address;
  reader: PublicClient;
  rpcUrl: string;
  code: string;
  keys?: MetaKeys;
}) {
  return movePayout({
    payout: args.receipt.payout,
    keys: args.keys ?? loadFreelancerKeys(),
    to: args.to,
    reader: args.reader,
    rpcUrl: args.rpcUrl,
    code: args.code,
  });
}
