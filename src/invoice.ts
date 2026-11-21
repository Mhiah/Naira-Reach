// Reading invoices. Two rules make the payment safe and private:
//  1. Naira Reach never pays an address written on an invoice. It pays the
//     freelancer's private receiving code, registered once by the client.
//  2. Personal details stay off-chain. Only a fingerprint (keccak256 of the
//     exact invoice file) is recorded with the payment.
import { keccak256, toBytes, type Hex } from "viem";

/** An invoice as it arrived: its file name and exact bytes. */
export type InvoiceFile = { name: string; bytes: Uint8Array };

export type Invoice = {
  invoiceId: string;
  /** Who is billing: matched against the client's approved freelancers. */
  freelancer: string;
  /** Exact naira amount billed. */
  amountNgn: number;
  description?: string;
  issuedAt?: string;
};

export type ReadInvoice = {
  invoice: Invoice;
  /** keccak256 of the invoice file's exact bytes. Proves later which invoice a payment settled. */
  fingerprint: Hex;
  /** Things worth flagging, e.g. a wallet address written on the invoice. */
  notes: string[];
  /** Wallet addresses written on the invoice. Shown to the client, never paid. */
  addresses: string[];
  source: "json" | "ai";
};

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/g;

/** Strip contact and banking details before any text leaves the machine. */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(ADDRESS_RE, "[wallet address]")
    .replace(/(\+?234|\b0)[789][01]\d{8}\b/g, "[phone]")
    .replace(/\b\d{10,11}\b/g, "[account or BVN number]");
}

export function fingerprint(bytes: Uint8Array | string): Hex {
  return keccak256(typeof bytes === "string" ? toBytes(bytes) : bytes);
}

export function validateInvoice(raw: unknown): Invoice {
  if (!raw || typeof raw !== "object") throw new Error("Invoice must be a JSON object.");
  const o = raw as Record<string, unknown>;
  const invoiceId = String(o.invoiceId ?? "").trim();
  const freelancer = String(o.freelancer ?? "").trim();
  const amountNgn = Number(o.amountNgn);
  if (!invoiceId) throw new Error("Invoice has no invoiceId.");
  if (!freelancer) throw new Error("Invoice has no freelancer.");
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) throw new Error("Invoice amountNgn must be a positive number.");
  if (Math.round(amountNgn * 1e6) !== amountNgn * 1e6) throw new Error("amountNgn has more than 6 decimal places.");
  return {
    invoiceId,
    freelancer,
    amountNgn,
    description: o.description ? String(o.description) : undefined,
    issuedAt: o.issuedAt ? String(o.issuedAt) : undefined,
  };
}

function addressNotes(text: string): string[] {
  return text.match(ADDRESS_RE)
    ? ["The invoice contains a wallet address. It was ignored: Naira Reach only pays the freelancer's registered private code."]
    : [];
}

const addressesIn = (text: string) => [...new Set(text.match(ADDRESS_RE) ?? [])];

export async function readInvoice(file: InvoiceFile, extractWithAi?: (redactedText: string) => Promise<Invoice>): Promise<ReadInvoice> {
  const text = new TextDecoder().decode(file.bytes);
  const fp = fingerprint(file.bytes);
  if (file.name.toLowerCase().endsWith(".json")) {
    return { invoice: validateInvoice(JSON.parse(text)), fingerprint: fp, notes: addressNotes(text), addresses: addressesIn(text), source: "json" };
  }
  if (!extractWithAi) {
    throw new Error("This invoice is plain text. Set ANTHROPIC_API_KEY so the agent can read it, or use the JSON format.");
  }
  const invoice = validateInvoice(await extractWithAi(redact(text)));
  return { invoice, fingerprint: fp, notes: addressNotes(text), addresses: addressesIn(text), source: "ai" };
}

/**
 * Read a free-form invoice with Claude. The model only ever sees the redacted
 * text, and it can only answer through a fixed schema.
 */
export function anthropicExtractor(apiKey: string, model: string, fetchFn: typeof fetch = fetch) {
  return async (redactedText: string): Promise<Invoice> => {
    const res = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        tool_choice: { type: "tool", name: "record_invoice" },
        tools: [
          {
            name: "record_invoice",
            description: "Record the fields of a freelancer's invoice.",
            input_schema: {
              type: "object",
              properties: {
                invoiceId: { type: "string", description: "The invoice number as written." },
                freelancer: { type: "string", description: "Name of the person or business billing." },
                amountNgn: { type: "number", description: "Total due in Nigerian naira. If the total is not in naira, use 0." },
                description: { type: "string", description: "Short summary of the work billed." },
                issuedAt: { type: "string", description: "Issue date as written, if any." },
              },
              required: ["invoiceId", "freelancer", "amountNgn"],
            },
          },
        ],
        messages: [
          {
            role: "user",
            content: `Read this invoice and record its fields. Do not guess: leave out anything not written.\n\n<invoice>\n${redactedText}\n</invoice>`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Invoice reader returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { content: { type: string; input?: unknown }[] };
    const call = body.content.find((c) => c.type === "tool_use");
    if (!call?.input) throw new Error("The invoice reader did not return any fields.");
    return validateInvoice(call.input);
  };
}
