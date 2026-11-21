// Moving a private payout. Shared by the command line and the website's Receive
// side, so it reads no files and no settings: everything comes in as arguments.
// Gas is paid in the USD₮ the agent sent along, since cNGN is not a Celo gas token.
// Built from viem's single actions so the browser bundle stays small.
import { createClient, encodeFunctionData, erc20Abi, getAddress, http, type Address, type Client, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readContract, sendTransaction, waitForTransactionReceipt } from "viem/actions";
import { celo } from "viem/chains";
import { TOKENS, USDT_FEE_CURRENCY } from "./celo.ts";
import { isMine, parseMetaAddress, stealthPrivateKey, type MetaKeys, type StealthPayout } from "./stealth.ts";
import { tagCalldata } from "./tag.ts";

/** The key that controls one payout address, after checking the payout is really ours. */
export function payoutAccount(p: StealthPayout, keys: MetaKeys) {
  const { spendingPublicKey } = parseMetaAddress(keys.metaAddress);
  if (!isMine(p, spendingPublicKey, keys.viewingPrivateKey)) throw new Error("This payout was not made to your receiving code.");
  const account = privateKeyToAccount(stealthPrivateKey(keys.spendingPrivateKey, keys.viewingPrivateKey, p.ephemeralPublicKey));
  if (account.address !== getAddress(p.stealthAddress)) throw new Error("Derived key does not match the payout address.");
  return account;
}

export async function payoutBalances(reader: Client, address: Address) {
  const read = (token: Address) => readContract(reader, { address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  const [cngn, usdt] = await Promise.all([read(TOKENS.CNGN), read(TOKENS.USDT)]);
  return { cngn, usdt };
}

export async function movePayout(args: {
  payout: StealthPayout;
  keys: MetaKeys;
  to: Address;
  reader: Client;
  rpcUrl: string;
  /** Attribution code to tag the transaction with, if known. */
  code?: string | null;
}): Promise<{ from: Address; to: Address; cngn: bigint; hash: Hex }> {
  const account = payoutAccount(args.payout, args.keys);
  const to = getAddress(args.to);
  if (to === account.address) throw new Error("That is the payout address itself. Send it to your own wallet or an exchange.");
  const { cngn } = await payoutBalances(args.reader, account.address);
  if (cngn === 0n) throw new Error("Nothing to move: this payout address holds no cNGN.");

  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, cngn] });
  const wallet = createClient({ account, chain: celo, transport: http(args.rpcUrl) });
  const hash = await sendTransaction(wallet, {
    account,
    chain: celo,
    to: TOKENS.CNGN,
    data: args.code ? tagCalldata(data, args.code) : data,
    feeCurrency: USDT_FEE_CURRENCY,
  });
  const receipt = await waitForTransactionReceipt(args.reader, { hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`The transfer failed on-chain: ${hash}`);
  return { from: account.address, to, cngn, hash };
}
