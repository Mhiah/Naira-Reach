// The freelancer's side: open a private payout and move the naira wherever they
// like (their own wallet, or an exchange deposit address to cash out). Gas is paid
// in the USD₮ the agent sent along, since cNGN is not a Celo gas token.
import { createWalletClient, encodeFunctionData, erc20Abi, getAddress, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { TOKENS, USDT_FEE_CURRENCY } from "./celo.ts";
import { readJson, statePath, writeJson } from "./config.ts";
import { generateMetaKeys, isMine, parseMetaAddress, stealthPrivateKey, type MetaKeys } from "./stealth.ts";
import { tagCalldata } from "./tag.ts";

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

type ReceiptPayout = { payout: { stealthAddress: Address; ephemeralPublicKey: Hex; viewTag: Hex } };

export async function claimPayout(args: {
  receipt: ReceiptPayout;
  to: Address;
  reader: PublicClient;
  rpcUrl: string;
  code: string;
  keys?: MetaKeys;
}) {
  const keys = args.keys ?? loadFreelancerKeys();
  const p = args.receipt.payout;
  const { spendingPublicKey } = parseMetaAddress(keys.metaAddress);
  if (!isMine(p, spendingPublicKey, keys.viewingPrivateKey)) throw new Error("This payout was not made to your receiving code.");

  const account = privateKeyToAccount(stealthPrivateKey(keys.spendingPrivateKey, keys.viewingPrivateKey, p.ephemeralPublicKey));
  if (account.address !== getAddress(p.stealthAddress)) throw new Error("Derived key does not match the payout address.");

  const balance = await args.reader.readContract({ address: TOKENS.CNGN, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  if (balance === 0n) throw new Error("Nothing to move: this payout address holds no cNGN.");

  const wallet = createWalletClient({ account, chain: celo, transport: http(args.rpcUrl) });
  const hash = await wallet.sendTransaction({
    to: TOKENS.CNGN,
    data: tagCalldata(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [args.to, balance] }), args.code),
    feeCurrency: USDT_FEE_CURRENCY,
  });
  await args.reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
  return { from: account.address, to: args.to, cngn: balance, hash };
}
