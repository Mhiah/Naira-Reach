// Textile FX RFQ API v2 (docs.textilecredit.com/api/v2/rfq.html).
// Naira Reach asks for an exact-output quote: "deliver exactly N cNGN", so the
// freelancer gets precisely what they billed and the client sees the USD₮ cost first.
import { getAddress, type Address, type Hex } from "viem";
import type { TakerProof } from "./proof.ts";

export type TextileTx = { to: Address; data: Hex; value: string; chainId: number };

export type FirmQuote = {
  rfqId: string;
  claimToken: string;
  quote: {
    sellAmount: string;
    buyAmount: string;
    feeAmount: string;
    /** Everything that leaves the taker's wallet, fee included. */
    takerPays: string;
    rateRay: string;
    expiresAt: string;
    orderDeadline?: string;
    reactor: Address;
    taker: Address;
  };
  transactions: { approval?: TextileTx; swap: TextileTx };
};

export type Preview = { takerPays: string; buyAmount: string; feeAmount: string };

export class TextileError extends Error {}

export class TextileClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(baseUrl: string, apiKey: string | undefined, fetchFn: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /**
   * Firm, executable quote bound to `taker`. Keyless callers prove control of the
   * taker wallet with `takerProof`; a partner API key skips the proof.
   */
  async requestQuote(args: {
    chainId: number;
    sellToken: Address;
    buyToken: Address;
    buyAmount: bigint;
    taker: Address;
    takerProof?: TakerProof;
  }): Promise<FirmQuote> {
    if (!this.apiKey && !args.takerProof) throw new TextileError("A keyless quote needs a taker proof.");
    const res = await this.fetchFn(`${this.baseUrl}/rfq/request`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        chainId: args.chainId,
        sellToken: args.sellToken,
        buyToken: args.buyToken,
        buyAmount: args.buyAmount.toString(),
        taker: args.taker,
        ...(this.apiKey ? {} : { takerProof: args.takerProof }),
      }),
      // The server may hold a firm request for up to ~75s while makers price it.
      signal: AbortSignal.timeout(75_000),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>; error?: unknown };
    if (!res.ok) throw new TextileError(`Textile /rfq/request returned ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
    const data = body.data ?? {};
    if (data.status !== "quoted") {
      throw new TextileError(`No firm quote (${String(data.status)}${data.reason ? `: ${String(data.reason)}` : ""}).`);
    }
    return parseQuote(data);
  }

  /**
   * Indicative price, no wallet and no reservation. Used for dry runs so they
   * never hold a maker's inventory or one of our four firm-quote slots.
   */
  async preview(args: { chainId: number; sellToken: Address; buyToken: Address; buyAmount: bigint }): Promise<Preview> {
    const res = await this.fetchFn(`${this.baseUrl}/rfq/preview`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        chainId: args.chainId,
        sellToken: args.sellToken,
        buyToken: args.buyToken,
        buyAmount: args.buyAmount.toString(),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown> };
    if (!res.ok) throw new TextileError(`Textile /rfq/preview returned ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
    const data = body.data ?? {};
    if (data.status !== "preview") throw new TextileError(`No preview price (${String(data.status)}${data.reason ? `: ${String(data.reason)}` : ""}).`);
    return { takerPays: String(data.takerPays), buyAmount: String(data.buyAmount), feeAmount: String(data.feeAmount) };
  }

  /** Report the swap hash. Optional: Textile also reconciles fills from chain. */
  async submit(rfqId: string, claimToken: string, txHash: Hex): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/rfq/${rfqId}/submit`, {
      method: "POST",
      headers: this.headers({ "X-Rfq-Claim": claimToken }),
      body: JSON.stringify({ txHash }),
    });
    if (!res.ok && res.status !== 409) throw new TextileError(`Textile /submit returned ${res.status}`);
  }

  async status(rfqId: string, claimToken: string): Promise<{ status: string; sellAmount?: string; buyAmount?: string }> {
    const res = await this.fetchFn(`${this.baseUrl}/rfq/${rfqId}`, { headers: this.headers({ "X-Rfq-Claim": claimToken }) });
    if (!res.ok) throw new TextileError(`Textile status returned ${res.status}`);
    return ((await res.json()) as { data: { status: string; sellAmount?: string; buyAmount?: string } }).data;
  }
}

export function parseQuote(data: Record<string, unknown>): FirmQuote {
  const quote = data.quote as Record<string, string> | undefined;
  const txs = data.transactions as { approval?: TextileTx; swap?: TextileTx } | undefined;
  if (!quote || !txs?.swap || typeof data.rfqId !== "string" || typeof data.claimToken !== "string") {
    throw new TextileError("Textile quote is missing rfqId, claimToken, quote or transactions.swap.");
  }
  const reactor = quote.reactor;
  const taker = quote.taker;
  if (!reactor || !taker) throw new TextileError("Textile quote is missing reactor or taker.");
  return {
    rfqId: data.rfqId,
    claimToken: data.claimToken,
    quote: {
      sellAmount: String(quote.sellAmount),
      buyAmount: String(quote.buyAmount),
      feeAmount: String(quote.feeAmount),
      takerPays: String(quote.takerPays),
      rateRay: String(quote.rateRay),
      expiresAt: String(quote.expiresAt),
      orderDeadline: quote.orderDeadline,
      reactor: getAddress(reactor),
      taker: getAddress(taker),
    },
    transactions: {
      approval: txs.approval ? { ...txs.approval, to: getAddress(txs.approval.to) } : undefined,
      swap: { ...txs.swap, to: getAddress(txs.swap.to) },
    },
  };
}

export function quoteExpired(q: FirmQuote, now = Date.now()): boolean {
  return now >= Date.parse(q.quote.expiresAt);
}
