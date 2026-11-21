import { describe, expect, it } from "vitest";

const modPath = "../web/api/textile.mjs";
const { handle } = (await import(modPath)) as { handle: (r: Request, f: typeof fetch) => Promise<Response> };

const SITE = "https://naira-reach.example";
const quote = { chainId: 42220, sellToken: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", buyToken: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f", buyAmount: "2000000000" };

function upstream() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{"data":{"status":"preview"}}', { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const req = (p: string, init: RequestInit & { origin?: string } = {}) =>
  new Request(`${SITE}/api/textile?p=${encodeURIComponent(p)}`, { ...init, headers: { ...(init.origin ? { origin: init.origin } : {}), ...(init.headers as Record<string, string>) } });

describe("Textile proxy", () => {
  it("passes on a USD₮ to cNGN quote on Celo", async () => {
    const u = upstream();
    const r = await handle(req("rfq/preview", { method: "POST", body: JSON.stringify(quote), origin: SITE }), u.fn);
    expect(r.status).toBe(200);
    expect(u.calls[0]!.url).toBe("https://api.textilecredit.com/v2/rfq/preview");
    expect(JSON.parse(String(u.calls[0]!.init.body))).toEqual(quote);
  });

  it("forwards the claim token for status and submit", async () => {
    const u = upstream();
    await handle(req("rfq/rfq_abc123", { headers: { "x-rfq-claim": "claim-1" } }), u.fn);
    await handle(req("rfq/rfq_abc123/submit", { method: "POST", body: "{}", headers: { "x-rfq-claim": "claim-1" } }), u.fn);
    expect(u.calls.map((c) => [c.url, c.init.method, (c.init.headers as Record<string, string>)["x-rfq-claim"]])).toEqual([
      ["https://api.textilecredit.com/v2/rfq/rfq_abc123", "GET", "claim-1"],
      ["https://api.textilecredit.com/v2/rfq/rfq_abc123/submit", "POST", "claim-1"],
    ]);
  });

  it("refuses anything else", async () => {
    const u = upstream();
    expect((await handle(req("../admin"), u.fn)).status).toBe(404);
    expect((await handle(req("rfq/preview"), u.fn)).status).toBe(405);
    expect((await handle(req("rfq/preview", { method: "POST", body: JSON.stringify({ ...quote, chainId: 1 }) }), u.fn)).status).toBe(400);
    expect((await handle(req("rfq/preview", { method: "POST", body: JSON.stringify({ ...quote, buyToken: quote.sellToken }) }), u.fn)).status).toBe(400);
    expect((await handle(req("rfq/preview", { method: "POST", body: JSON.stringify(quote), origin: "https://evil.test" }), u.fn)).status).toBe(403);
    expect(u.calls).toHaveLength(0);
  });
});
