// Taking money out of the client's own wallet: USD₮ or CELO to any address the client
// pastes. Signed by the client's own wallet key, not the agent's limited key, so the
// agent can never do this and its weekly limits don't apply. The wallet sends it
// itself, so a USD₮ withdrawal carries the attribution tag like a payment does.
import { createClient, encodeFunctionData, erc20Abi, formatUnits, getAddress, http, isAddress, parseUnits, type Address, type Client, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { estimateGas, getBalance, getGasPrice, readContract, sendTransaction, waitForTransactionReceipt } from "viem/actions";
import { celo } from "viem/chains";
import { DECIMALS, TEXTILE_REACTOR, TOKENS, USDT_FEE_CURRENCY } from "./celo.ts";
import { tagCalldata } from "./tag.ts";

export type WithdrawToken = "USDT" | "CELO";

/** USD₮ kept back by "Max", to pay the network fee in USD₮. Celo fees are a fraction of a cent. */
export const USDT_FEE_RESERVE = 0.02;

/** Refuse addresses where money would be lost or would go nowhere useful. */
export function checkDestination(to: string, wallet: Address): Address {
  const t = to.trim();
  if (!isAddress(t, { strict: false })) throw new Error("That isn't a Celo address. It should start with 0x and be 42 characters long.");
  const a = getAddress(t);
  if (/^0x0{40}$/i.test(a)) throw new Error("That is the empty (zero) address. Money sent there is lost for good.");
  if (a === getAddress(wallet)) throw new Error("That is this wallet itself. Paste your exchange's deposit address or another wallet.");
  const contracts = [TOKENS.CNGN, TOKENS.USDT, USDT_FEE_CURRENCY, TEXTILE_REACTOR].map((x) => getAddress(x));
  if (contracts.includes(a)) throw new Error("That is a contract, not a wallet. Money sent there would be lost.");
  return a;
}

/** "12.5" → base units, with at most the token's decimals. "max" is handled by the caller. */
export function parseAmount(amount: string, token: WithdrawToken): bigint {
  const t = amount.replace(/[,\s]/g, "");
  const decimals = token === "USDT" ? DECIMALS.USDT : 18;
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("Enter the amount as a number, like 5 or 2.5.");
  if ((t.split(".")[1] ?? "").length > decimals) throw new Error(`That's more decimal places than ${token === "USDT" ? "USD₮" : "CELO"} has.`);
  const v = parseUnits(t, decimals);
  if (v <= 0n) throw new Error("The amount must be more than zero.");
  return v;
}

export async function withdraw(args: {
  adminKey: Hex;
  rpcUrl: string;
  token: WithdrawToken;
  to: string;
  /** A number as typed, or "max". */
  amount: string;
  code?: string | null;
  reader?: Client;
}): Promise<{ token: WithdrawToken; amount: string; to: Address; hash: Hex }> {
  const account = privateKeyToAccount(args.adminKey);
  const to = checkDestination(args.to, account.address);
  const chain = createClient({ account, chain: celo, transport: http(args.rpcUrl) });
  const reader = (args.reader ?? chain) as Client;
  const max = args.amount.trim().toLowerCase() === "max";

  if (args.token === "USDT") {
    const balance = await readContract(reader, { address: TOKENS.USDT, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    const reserve = parseUnits(String(USDT_FEE_RESERVE), DECIMALS.USDT);
    const value = max ? balance - reserve : parseAmount(args.amount, "USDT");
    if (value <= 0n) throw new Error("There isn't enough USD₮ to withdraw after the network fee.");
    if (value + reserve > balance) {
      throw new Error(`Not enough USD₮: the wallet has ${formatUnits(balance, DECIMALS.USDT)}, and about ${USDT_FEE_RESERVE} stays for the network fee.`);
    }
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, value] });
    const hash = await sendTransaction(chain, { account, chain: celo, to: TOKENS.USDT, data: args.code ? tagCalldata(data, args.code) : data, feeCurrency: USDT_FEE_CURRENCY });
    const r = await waitForTransactionReceipt(reader, { hash, timeout: 180_000 });
    if (r.status !== "success") throw new Error(`The withdrawal failed on-chain: ${hash}`);
    return { token: "USDT", amount: formatUnits(value, DECIMALS.USDT), to, hash };
  }

  // CELO: a plain transfer, fee paid in CELO. No tag: extra data can upset a contract wallet.
  const balance = await getBalance(reader, { address: account.address });
  const gas = await estimateGas(chain, { account, to, value: 1n });
  const fee = ((gas * 12n) / 10n) * ((await getGasPrice(reader)) * 2n);
  const value = max ? balance - fee : parseAmount(args.amount, "CELO");
  if (value <= 0n) throw new Error("There isn't enough CELO to withdraw after the network fee.");
  if (value + fee > balance) throw new Error(`Not enough CELO: the wallet has ${formatUnits(balance, 18)}, and a little stays for the network fee.`);
  const hash = await sendTransaction(chain, { account, chain: celo, to, value, gas: (gas * 12n) / 10n });
  const r = await waitForTransactionReceipt(reader, { hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`The withdrawal failed on-chain: ${hash}`);
  return { token: "CELO", amount: formatUnits(value, 18), to, hash };
}
