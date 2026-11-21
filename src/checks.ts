// The client's list of approved freelancers, the ledger of paid invoices, and
// the checks the agent runs before any money moves. A failed check is a hold:
// the agent stops and the client decides.
import type { Hex } from "viem";
import { readJson, statePath, writeJson } from "./config.ts";
import type { Invoice } from "./invoice.ts";

export type Freelancer = {
  id: string;
  name: string;
  aliases?: string[];
  /** ERC-5564 stealth meta-address the freelancer shared once (st:celo:0x...). */
  metaAddress: string;
  /** Largest single invoice the client expects from this freelancer, in naira. */
  maxInvoiceNgn?: number;
  /** If set, every invoice must be exactly this amount (a fixed retainer). */
  agreedNgn?: number;
};

export type PaidEntry = {
  invoiceId: string;
  freelancerId: string;
  fingerprint: Hex;
  amountNgn: number;
  paidAt: string;
  receipt: string;
};

const FREELANCERS = () => statePath("freelancers.json");
const LEDGER = () => statePath("ledger.json");

export const loadFreelancers = () => readJson<Freelancer[]>(FREELANCERS(), []);
export const saveFreelancers = (list: Freelancer[]) => writeJson(FREELANCERS(), list);
export const loadLedger = () => readJson<PaidEntry[]>(LEDGER(), []);
export const recordPaid = (entry: PaidEntry) => writeJson(LEDGER(), [...loadLedger(), entry]);

const norm = (s: string) => s.trim().toLowerCase();

export function findFreelancer(list: Freelancer[], who: string): Freelancer | undefined {
  const w = norm(who);
  return list.find((f) => norm(f.id) === w || norm(f.name) === w || (f.aliases ?? []).some((a) => norm(a) === w));
}

export type CheckResult = { freelancer?: Freelancer; holds: string[] };

/** Checks that need no quote: who is billing, duplicates, and the agreed amount. */
export function checkInvoice(invoice: Invoice, fp: Hex, freelancers: Freelancer[], ledger: PaidEntry[]): CheckResult {
  const holds: string[] = [];
  const freelancer = findFreelancer(freelancers, invoice.freelancer);
  if (!freelancer) {
    holds.push(`"${invoice.freelancer}" is not on your approved freelancer list.`);
    return { holds };
  }
  if (ledger.some((p) => p.fingerprint === fp)) holds.push("This exact invoice has already been paid.");
  if (ledger.some((p) => p.freelancerId === freelancer.id && norm(p.invoiceId) === norm(invoice.invoiceId))) {
    holds.push(`Invoice ${invoice.invoiceId} from ${freelancer.name} has already been paid.`);
  }
  if (freelancer.agreedNgn !== undefined && invoice.amountNgn !== freelancer.agreedNgn) {
    holds.push(`Amount ₦${fmt(invoice.amountNgn)} differs from the agreed ₦${fmt(freelancer.agreedNgn)}.`);
  }
  if (freelancer.maxInvoiceNgn !== undefined && invoice.amountNgn > freelancer.maxInvoiceNgn) {
    holds.push(`Amount ₦${fmt(invoice.amountNgn)} is above this freelancer's limit of ₦${fmt(freelancer.maxInvoiceNgn)}.`);
  }
  return { freelancer, holds };
}

/** Check that needs the quote: the dollar cost against the client's per-invoice ceiling. */
export function checkCost(usdtCost: number, maxUsdt: number): string[] {
  return usdtCost > maxUsdt ? [`This invoice would cost ${usdtCost.toFixed(2)} USD₮, above your limit of ${maxUsdt} USD₮.`] : [];
}

export const fmt = (n: number) => n.toLocaleString("en-NG", { maximumFractionDigits: 2 });
