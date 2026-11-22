// The client's list of approved freelancers, the ledger of paid invoices, and
// the checks the agent runs before any money moves. A failed check is a hold:
// the agent stops and the client decides.
import type { Hex } from "viem";
import { store } from "./store.ts";
import type { Invoice } from "./invoice.ts";

export type Freelancer = {
  id: string;
  name: string;
  /** What they do for the client, shown on the website only. */
  role?: string;
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

/** An invoice the agent stopped. Nothing was sent. */
export type HeldEntry = {
  invoiceId: string;
  fingerprint: Hex;
  /** Who the invoice says is billing, as written. */
  billedBy: string;
  amountNgn: number;
  reasons: string[];
  heldAt: string;
};

/**
 * One line of the check list the client sees.
 *  hold "review": the client may look and pay anyway.
 *  hold "block":  paying cannot work (unknown payee, no price, no key).
 *  ignored:       something on the invoice the agent deliberately did not use.
 */
export type CheckRow = {
  ok: boolean;
  title: string;
  note: string;
  hold?: "review" | "block";
  ignored?: boolean;
  /** A setup gap (no key, no price), not a reason to distrust the invoice. */
  setup?: boolean;
};

const FREELANCERS = "freelancers.json";
const LEDGER = "ledger.json";
const HOLDS = "holds.json";

export const loadFreelancers = () => store().read<Freelancer[]>(FREELANCERS, []);
export const saveFreelancers = (list: Freelancer[]) => store().write(FREELANCERS, list);
export const loadLedger = () => store().read<PaidEntry[]>(LEDGER, []);
export const recordPaid = (entry: PaidEntry) => store().write(LEDGER, [...loadLedger(), entry]);
export const loadHolds = () => store().read<HeldEntry[]>(HOLDS, []);
/** An invoice that was held and later paid is no longer held. */
export const clearHold = (fp: Hex) => {
  const all = loadHolds();
  if (all.some((h) => h.fingerprint === fp)) store().write(HOLDS, all.filter((h) => h.fingerprint !== fp));
};
/** Keep one entry per invoice file: checking the same file twice is not a second attempt. */
export const recordHold = (entry: HeldEntry) =>
  store().write(HOLDS, [...loadHolds().filter((h) => h.fingerprint !== entry.fingerprint), entry].slice(-200));

const norm = (s: string) => s.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");

export function findFreelancer(list: Freelancer[], who: string): Freelancer | undefined {
  const w = norm(who);
  return list.find((f) => norm(f.id) === w || norm(f.name) === w || (f.aliases ?? []).some((a) => norm(a) === w));
}

export type CheckResult = { freelancer?: Freelancer; holds: string[]; rows: CheckRow[] };

/** Checks that need no quote: who is billing, duplicates, and the agreed amount. */
export function checkInvoice(invoice: Invoice, fp: Hex, freelancers: Freelancer[], ledger: PaidEntry[]): CheckResult {
  const rows: CheckRow[] = [];
  const freelancer = findFreelancer(freelancers, invoice.freelancer);
  if (!freelancer) {
    rows.push({
      ok: false,
      title: `"${invoice.freelancer}" is not on your list`,
      note: `"${invoice.freelancer}" is not on your approved freelancer list.`,
      hold: "block",
    });
    return { rows, holds: holdsOf(rows) };
  }
  rows.push({ ok: true, title: `${freelancer.name} is on your list`, note: "Paid only at the private code they gave you" });

  const sameFile = ledger.some((p) => p.fingerprint === fp);
  const sameNumber = ledger.some((p) => p.freelancerId === freelancer.id && norm(p.invoiceId) === norm(invoice.invoiceId));
  if (sameFile) rows.push({ ok: false, title: "Paid before", note: "This exact invoice has already been paid.", hold: "review" });
  if (sameNumber) {
    rows.push({ ok: false, title: "Paid before", note: `Invoice ${invoice.invoiceId} from ${freelancer.name} has already been paid.`, hold: "review" });
  }
  if (!sameFile && !sameNumber) rows.push({ ok: true, title: "Not paid before", note: `No earlier ${invoice.invoiceId}, and this file is new` });

  if (freelancer.agreedNgn !== undefined) {
    rows.push(
      invoice.amountNgn === freelancer.agreedNgn
        ? { ok: true, title: "Matches the agreed amount", note: `₦${fmt(freelancer.agreedNgn)}` }
        : {
            ok: false,
            title: "Not the agreed amount",
            note: `Amount ₦${fmt(invoice.amountNgn)} differs from the agreed ₦${fmt(freelancer.agreedNgn)}.`,
            hold: "review",
          },
    );
  }
  if (freelancer.maxInvoiceNgn !== undefined) {
    rows.push(
      invoice.amountNgn <= freelancer.maxInvoiceNgn
        ? { ok: true, title: `Within ${firstName(freelancer.name)}'s limit`, note: `₦${fmt(invoice.amountNgn)} of ₦${fmt(freelancer.maxInvoiceNgn)}` }
        : {
            ok: false,
            title: `Over ${firstName(freelancer.name)}'s limit`,
            note: `Amount ₦${fmt(invoice.amountNgn)} is above this freelancer's limit of ₦${fmt(freelancer.maxInvoiceNgn)}.`,
            hold: "review",
          },
    );
  }
  return { freelancer, rows, holds: holdsOf(rows) };
}

/** Check that needs the quote: the dollar cost against the client's per-invoice ceiling. */
export function checkCost(usdtCost: number, maxUsdt: number): string[] {
  return usdtCost > maxUsdt ? [`This invoice would cost ${usdtCost.toFixed(2)} USD₮, above your limit of ${maxUsdt} USD₮.`] : [];
}

export const holdsOf = (rows: CheckRow[]) => rows.filter((r) => r.hold).map((r) => r.note);
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
export const fmt = (n: number) => n.toLocaleString("en-NG", { maximumFractionDigits: 2 });
