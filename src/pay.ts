// One invoice, start to finish:
//   read → check → derive a private payout address → lock a Textile quote for the
//   exact naira → (one atomic intent) approve, swap USD₮→cNGN, pay cNGN + gas money
//   → report → receipt.
import { erc20Abi, encodeFunctionData, formatUnits, getAddress, parseAbi, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { CELO_CHAIN_ID, DECIMALS, EXPLORER_TX, TEXTILE_REACTOR, TOKENS } from "./celo.ts";
import { checkCost, checkInvoice, loadFreelancers, loadLedger, recordPaid, type Freelancer } from "./checks.ts";
import { receiptsDir, writeJson } from "./config.ts";
import type { Call, Executor } from "./executor.ts";
import { readInvoice, type Invoice } from "./invoice.ts";
import { erc20Metadata, newStealthAddress, SCHEME_ID, type StealthPayout } from "./stealth.ts";
import { verifyTag } from "./tag.ts";
import { quoteExpired, type FirmQuote, type TextileClient } from "./textile.ts";

const ANNOUNCER_ABI = parseAbi(["function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)"]);

export type PayDeps = {
  /** Needed to send. A dry run works without one. */
  executor?: Executor;
  textile: TextileClient;
  reader: PublicClient;
  code: string;
  maxUsdt: number;
  gasTopUpUsdt: number;
  announcer?: Address;
  extractor?: (redactedText: string) => Promise<Invoice>;
  /** Pay even if a check raised a hold (the client has looked and approved). */
  approveHolds?: boolean;
  dryRun?: boolean;
  log?: (line: string) => void;
};

export type PayOutcome =
  | { status: "held"; holds: string[]; notes: string[] }
  | { status: "planned"; preview: DryRun; notes: string[] }
  | { status: "paid"; plan: Plan; receiptPath: string; hashes: Hex[]; tags: { hash: Hex; tagged: boolean }[]; notes: string[] }
  | { status: "failed"; plan: Plan; hashes: Hex[]; notes: string[] };

export type DryRun = {
  invoice: Invoice;
  freelancer: Freelancer;
  payout: StealthPayout;
  usdtCost: number;
  ngnPerUsdt: number;
  steps: string[];
};

export type Plan = {
  invoice: Invoice;
  fingerprint: Hex;
  freelancer: Freelancer;
  payout: StealthPayout;
  quote: FirmQuote;
  usdtCost: number;
  ngnPerUsdt: number;
  calls: Call[];
};

export async function payInvoice(invoicePath: string, d: PayDeps): Promise<PayOutcome> {
  const log = d.log ?? (() => {});

  // 1. Read the invoice. Only redacted text ever reaches the AI reader.
  const { invoice, fingerprint, notes } = await readInvoice(invoicePath, d.extractor);
  log(`Invoice ${invoice.invoiceId} from ${invoice.freelancer}: ₦${invoice.amountNgn.toLocaleString("en-NG")}`);

  // 2. Checks that need no money: approved freelancer, duplicates, agreed amount.
  const check = checkInvoice(invoice, fingerprint, loadFreelancers(), loadLedger());
  if (check.holds.length && !d.approveHolds) return { status: "held", holds: check.holds, notes };
  const freelancer = check.freelancer;
  if (!freelancer) return { status: "held", holds: check.holds, notes };

  // 3. A fresh private address for this payout only.
  const payout = newStealthAddress(freelancer.metaAddress);

  const buyAmount = parseUnits(String(invoice.amountNgn), DECIMALS.CNGN);
  const gasTopUp = parseUnits(String(d.gasTopUpUsdt), DECIMALS.USDT);

  // Dry run: an indicative price only. No wallet, no firm quote, nothing reserved or sent.
  if (d.dryRun) {
    const p = await d.textile.preview({ chainId: CELO_CHAIN_ID, sellToken: TOKENS.USDT, buyToken: TOKENS.CNGN, buyAmount });
    const usdtCost = Number(formatUnits(BigInt(p.takerPays), DECIMALS.USDT));
    const costHolds = checkCost(usdtCost, d.maxUsdt);
    if (costHolds.length && !d.approveHolds) return { status: "held", holds: costHolds, notes };
    const steps = ["approve", "swap", "payout", ...(gasTopUp > 0n ? ["gas money"] : []), ...(d.announcer ? ["announce"] : [])];
    return {
      status: "planned",
      preview: { invoice, freelancer, payout, usdtCost, ngnPerUsdt: invoice.amountNgn / usdtCost, steps },
      notes,
    };
  }

  const executor = d.executor;
  if (!executor) throw new Error("No wallet to pay from. The client grants the agent a session first.");

  // 4. Firm quote for the exact naira amount, bound to the paying wallet.
  const quote = await d.textile.requestQuote({
    chainId: CELO_CHAIN_ID,
    sellToken: TOKENS.USDT,
    buyToken: TOKENS.CNGN,
    buyAmount,
    taker: executor.address,
  });
  assertQuote(quote, executor.address, buyAmount);
  const takerPays = BigInt(quote.quote.takerPays);
  const usdtCost = Number(formatUnits(takerPays, DECIMALS.USDT));
  const ngnPerUsdt = invoice.amountNgn / usdtCost;
  log(`Quote ${quote.rfqId}: ${usdtCost.toFixed(4)} USD₮ for ₦${invoice.amountNgn.toLocaleString("en-NG")} (₦${ngnPerUsdt.toFixed(2)} per USD₮)`);

  // 5. The client's per-invoice dollar ceiling.
  const costHolds = checkCost(usdtCost, d.maxUsdt);
  if (costHolds.length && !d.approveHolds) return { status: "held", holds: costHolds, notes };

  // 6. Build the calls. With Altana they run as one atomic intent: all or nothing.
  const allowance = await d.reader.readContract({
    address: TOKENS.USDT,
    abi: erc20Abi,
    functionName: "allowance",
    args: [executor.address, quote.quote.reactor],
  });
  const plan: Plan = {
    invoice,
    fingerprint,
    freelancer,
    payout,
    quote,
    usdtCost,
    ngnPerUsdt,
    calls: buildCalls({ quote, payout, buyAmount, allowance, gasTopUp, announcer: d.announcer }),
  };

  if (quoteExpired(quote)) throw new Error("The quote expired before sending. Run the payment again for a fresh quote.");

  // 7. Send.
  log(`Sending ${plan.calls.length} calls through the ${executor.kind} wallet ${executor.address}…`);
  const sent = await executor.send(plan.calls);
  if (sent.status !== "CONFIRMED") return { status: "failed", plan, hashes: sent.hashes, notes };

  // 8. Tell Textile which transaction filled the quote (optional; it also reads the chain).
  const swapHash = executor.kind === "altana" ? sent.hashes[0] : sent.hashes[plan.calls.findIndex((c) => c.label === "swap")];
  if (swapHash) await d.textile.submit(quote.rfqId, quote.claimToken, swapHash).catch((e) => log(`Textile submit: ${String(e)}`));

  // 9. Check the tag is readable on-chain on every transaction.
  const tags = await Promise.all(sent.hashes.map((h) => verifyTag(d.reader, h, d.code).catch(() => ({ hash: h, codes: [], tagged: false }))));

  // 10. Receipt and ledger. No names, emails or bank details: just the fingerprint.
  const receiptPath = `${receiptsDir()}/${safe(invoice.invoiceId)}-${Date.now()}.json`;
  writeJson(receiptPath, receipt(plan, d, executor, sent.hashes, tags));
  recordPaid({
    invoiceId: invoice.invoiceId,
    freelancerId: freelancer.id,
    fingerprint,
    amountNgn: invoice.amountNgn,
    paidAt: new Date().toISOString(),
    receipt: receiptPath,
  });
  return { status: "paid", plan, receiptPath, hashes: sent.hashes, tags, notes };
}

export function assertQuote(q: FirmQuote, taker: Address, buyAmount: bigint): void {
  if (getAddress(q.quote.taker) !== getAddress(taker)) throw new Error("Quote is bound to a different wallet.");
  if (getAddress(q.quote.reactor) !== TEXTILE_REACTOR || getAddress(q.transactions.swap.to) !== TEXTILE_REACTOR) {
    throw new Error("Quote points at an unexpected contract; refusing to send.");
  }
  if (BigInt(q.quote.buyAmount) < buyAmount) throw new Error("Quote delivers less naira than the invoice.");
  if (q.transactions.swap.value !== "0" && BigInt(q.transactions.swap.value) !== 0n) throw new Error("Swap unexpectedly carries CELO.");
}

export function buildCalls(a: {
  quote: FirmQuote;
  payout: StealthPayout;
  buyAmount: bigint;
  allowance: bigint;
  gasTopUp: bigint;
  announcer?: Address;
}): Call[] {
  const takerPays = BigInt(a.quote.quote.takerPays);
  const reactor = a.quote.quote.reactor;
  const calls: Call[] = [];
  if (a.allowance < takerPays) {
    // USD₮-style tokens refuse to change a non-zero allowance directly.
    if (a.allowance > 0n) calls.push(approve(reactor, 0n, "reset allowance"));
    calls.push(approve(reactor, takerPays, "approve"));
  }
  calls.push({ to: a.quote.transactions.swap.to, data: a.quote.transactions.swap.data, label: "swap" });
  calls.push({
    to: TOKENS.CNGN,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [a.payout.stealthAddress, a.buyAmount] }),
    label: "payout",
  });
  if (a.gasTopUp > 0n) {
    calls.push({
      to: TOKENS.USDT,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [a.payout.stealthAddress, a.gasTopUp] }),
      label: "gas money",
    });
  }
  if (a.announcer) {
    calls.push({
      to: a.announcer,
      data: encodeFunctionData({
        abi: ANNOUNCER_ABI,
        functionName: "announce",
        args: [SCHEME_ID, a.payout.stealthAddress, a.payout.ephemeralPublicKey, erc20Metadata(a.payout.viewTag, a.buyAmount)],
      }),
      label: "announce",
    });
  }
  return calls;
}

function approve(spender: Address, amount: bigint, label: string): Call {
  return { to: TOKENS.USDT, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }), label };
}

function receipt(plan: Plan, d: PayDeps, executor: Executor, hashes: Hex[], tags: { hash: Hex; tagged: boolean }[]) {
  return {
    product: "Naira Reach",
    paidAt: new Date().toISOString(),
    invoice: {
      invoiceId: plan.invoice.invoiceId,
      freelancerId: plan.freelancer.id,
      amountNgn: plan.invoice.amountNgn,
      fingerprint: plan.fingerprint,
    },
    cost: { usdt: plan.usdtCost, ngnPerUsdt: Number(plan.ngnPerUsdt.toFixed(4)), textileRfqId: plan.quote.rfqId },
    payout: {
      // The freelancer needs these two values to open the payout address.
      stealthAddress: plan.payout.stealthAddress,
      ephemeralPublicKey: plan.payout.ephemeralPublicKey,
      viewTag: plan.payout.viewTag,
      cngn: plan.invoice.amountNgn,
      gasMoneyUsdt: d.gasTopUpUsdt,
    },
    wallet: { kind: executor.kind, address: executor.address },
    transactions: hashes.map((h) => ({ hash: h, explorer: EXPLORER_TX(h), tagged: tags.find((t) => t.hash === h)?.tagged ?? false })),
  };
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);
