import { mkdirSync, writeFileSync } from "node:fs";
import { request, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress, type Hex, type PublicClient } from "viem";
import { TEXTILE_REACTOR, TOKENS } from "../src/celo.ts";
import { loadFreelancers, loadHolds, saveFreelancers, recordPaid } from "../src/checks.ts";
import type { PayOutcome } from "../src/pay.ts";
import { generateMetaKeys } from "../src/stealth.ts";
import { TextileClient } from "../src/textile.ts";
import { createWebApp, type Actions } from "../src/web.ts";
import { fakeFetch, freshState } from "./helpers.ts";

const TOKEN = "t0ken";
const WALLET = getAddress("0x1234567890abcdef1234567890abcdef12345678");
const NOW = Date.parse("2026-11-21T10:00:00Z"); // a Saturday; the week began Monday 16 Nov

let server: Server;
let port = 0;
let dir = "";
let payCalls: { path: string; opts: { approvedUsdt: number; approveHolds: boolean } }[] = [];

function textile() {
  return fakeFetch((url, init) => {
    const body = JSON.parse(String(init.body)) as { buyAmount: string };
    if (url.endsWith("/rfq/preview")) {
      // 1,444.57 naira per USD₮, fee 0.02 per 100.
      const pays = Math.ceil((Number(body.buyAmount) / 1444.57) * 1.0002);
      return { body: { data: { status: "preview", takerPays: String(pays), buyAmount: body.buyAmount, feeAmount: String(Math.round(pays * 0.0002)) } } };
    }
    return { status: 500, body: {} };
  });
}

const reader = {
  readContract: async ({ address }: { address: string }) => (getAddress(address) === TOKENS.USDT ? 5_000_000n : 0n),
} as unknown as PublicClient;

async function start(actions: Partial<Actions> = {}) {
  let handle: ReturnType<typeof createWebApp> | undefined;
  server = createServer((req, res) => void handle!(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  handle = createWebApp({
    webDir: join(import.meta.dirname, "..", "web"),
    port,
    token: TOKEN,
    textile: new TextileClient("https://textile.test/v2", undefined, textile().fn),
    reader,
    now: () => NOW,
    actions,
  });
}

function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; text: string; json: () => any }>((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: `localhost:${port}`,
          "x-naira-reach-token": TOKEN,
          ...(data ? { "content-type": "application/json", origin: `http://localhost:${port}` } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const upload = (name: string, content: string) => call("POST", "/api/invoices", { body: { name, data: Buffer.from(content).toString("base64") } });

function seedSession(usdtPerWeek: number, cngnPerWeek: number) {
  const home = process.env.NAIRA_REACH_HOME!;
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "session.json"),
    JSON.stringify({
      walletAddress: WALLET,
      publicKey: "0x04",
      permissions: {
        calls: [{ to: TOKENS.USDT, signature: "approve(address,uint256)" }, { to: TEXTILE_REACTOR }],
        spend: [
          { token: TOKENS.USDT, limit: String(usdtPerWeek * 1e6), period: "week" },
          { token: TOKENS.CNGN, limit: String(cngnPerWeek * 1e6), period: "week" },
        ],
      },
      expiry: Math.floor(NOW / 1000) + 7 * 86_400,
    }),
  );
  writeFileSync(join(home, "session.key"), JSON.stringify({ privateKey: "0x" + "11".repeat(32) }));
  writeFileSync(join(home, "client.json"), JSON.stringify({ walletAddress: WALLET, activatedAt: "2026-11-20T09:00:00Z" }));
}

const ada = () => ({ id: "ada", name: "Ada Obi", metaAddress: generateMetaKeys().metaAddress, maxInvoiceNgn: 500_000 });

beforeEach(() => {
  dir = freshState();
  payCalls = [];
  delete process.env.CLIENT_ADMIN_PRIVATE_KEY;
  process.env.ATTRIBUTION_CODE = "celo_test";
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe("who may use the agent", () => {
  beforeEach(() => start());

  it("serves the page with this run's token and refuses to be framed", async () => {
    const r = await call("GET", "/");
    expect(r.status).toBe(200);
    expect(r.text).toContain(`"token":"${TOKEN}"`);
    expect(r.text).not.toContain('src="config.js"');
    expect(String(r.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
  });

  it("refuses another host name (DNS rebinding)", async () => {
    expect((await call("GET", "/", { headers: { host: `evil.test:${port}` } })).status).toBe(403);
    expect((await call("GET", "/api/state", { headers: { host: `evil.test:${port}` } })).status).toBe(403);
  });

  it("refuses API calls without the token", async () => {
    expect((await call("GET", "/api/state", { headers: { "x-naira-reach-token": "nope" } })).status).toBe(403);
  });

  it("refuses changes sent from another website, or not as JSON", async () => {
    const other = await call("POST", "/api/freelancers", { body: {}, headers: { origin: "https://evil.test" } });
    expect(other.status).toBe(403);
    const form = await call("POST", "/api/session/revoke", { headers: { "content-type": "text/plain" } });
    expect(form.status).toBe(415);
  });

  it("does not serve files outside the website folder", async () => {
    expect((await call("GET", "/../package.json")).status).toBe(404);
    expect((await call("GET", "/%2e%2e/.env")).status).toBe(404);
  });
});

describe("state", () => {
  beforeEach(() => start());

  it("works before anything is set up", async () => {
    const s = (await call("GET", "/api/state")).json();
    expect(s.wallet.address).toBeNull();
    expect(s.session).toBeNull();
    expect(s.rate.ok).toBe(true);
    expect(s.rate.ngnPerUsdt).toBeGreaterThan(1400);
    expect(s.payouts).toEqual([]);
  });

  it("adds up this week's spending from the receipts", async () => {
    seedSession(200, 300_000);
    const receipts = process.env.NAIRA_REACH_RECEIPTS!;
    mkdirSync(receipts, { recursive: true });
    const write = (name: string, usdt: number) => {
      const p = join(receipts, name);
      writeFileSync(p, JSON.stringify({ cost: { usdt }, payout: { gasMoneyUsdt: 0.05 }, transactions: [{ hash: "0x" + "ab".repeat(32), tagged: true }] }));
      return p;
    };
    recordPaid({ invoiceId: "A-1", freelancerId: "ada", fingerprint: "0x01", amountNgn: 150_000, paidAt: "2026-11-20T12:00:00Z", receipt: write("A-1-1.json", 103.9) });
    recordPaid({ invoiceId: "A-0", freelancerId: "ada", fingerprint: "0x02", amountNgn: 85_000, paidAt: "2026-11-14T12:00:00Z", receipt: write("A-0-1.json", 59) });
    saveFreelancers([ada()]);

    const s = (await call("GET", "/api/state")).json();
    expect(s.wallet.address).toBe(WALLET);
    expect(s.wallet.live.usdt).toBe(5);
    expect(s.session.usdtPerWeek).toBe(200);
    expect(s.session.used.cngn).toBe(150_000);
    expect(s.session.used.usdt).toBeCloseTo(103.95);
    expect(s.session.calls[0].what).toBe("Approve USD₮ for the swap");
    expect(s.freelancers[0]).toMatchObject({ name: "Ada Obi", paid: 2, totalNgn: 235_000 });
    expect(s.payouts.map((p: { invoiceId: string }) => p.invoiceId)).toEqual(["A-1", "A-0"]);
    expect(s.payouts[0].receipt).toBe("A-1-1.json");
    expect(s.weekly.ngn.slice(-2)).toEqual([85_000, 150_000]);
  });

  it("hands out a receipt by name only", async () => {
    mkdirSync(process.env.NAIRA_REACH_RECEIPTS!, { recursive: true });
    writeFileSync(join(process.env.NAIRA_REACH_RECEIPTS!, "INV-1-123.json"), JSON.stringify({ product: "Naira Reach" }));
    expect((await call("GET", "/api/receipts/INV-1-123.json")).json()).toEqual({ product: "Naira Reach" });
    expect((await call("GET", "/api/receipts/..%2F.env")).status).toBe(400);
  });
});

describe("freelancers", () => {
  beforeEach(() => start());

  it("adds a freelancer only with a valid receiving code, once", async () => {
    const code = generateMetaKeys().metaAddress;
    expect((await call("POST", "/api/freelancers", { body: { name: "Ada Obi", metaAddress: "st:celo:0x1234" } })).status).toBe(400);
    const ok = await call("POST", "/api/freelancers", { body: { name: "Ada Obi", metaAddress: code, maxInvoiceNgn: "500,000", aliases: "ada, Ada O." } });
    expect(ok.json()).toEqual({ id: "ada-obi" });
    expect(loadFreelancers()[0]).toMatchObject({ maxInvoiceNgn: 500_000, aliases: ["ada", "Ada O."] });
    expect((await call("POST", "/api/freelancers", { body: { name: "Someone", metaAddress: code } })).status).toBe(400);
    expect((await call("DELETE", "/api/freelancers/ada-obi")).json()).toEqual({ removed: "ada-obi" });
    expect(loadFreelancers()).toEqual([]);
  });
});

describe("invoices", () => {
  const paidOutcome = (): PayOutcome =>
    ({
      status: "paid",
      plan: {
        invoice: { invoiceId: "INV-1", freelancer: "ada", amountNgn: 150_000 },
        freelancer: { id: "ada", name: "Ada Obi", metaAddress: "" },
        payout: { stealthAddress: WALLET },
        usdtCost: 103.9,
      },
      receiptPath: "receipts/INV-1-1.json",
      hashes: [("0x" + "ab".repeat(32)) as Hex],
      tags: [{ hash: ("0x" + "ab".repeat(32)) as Hex, tagged: true }],
      notes: [],
    }) as unknown as PayOutcome;

  beforeEach(() =>
    start({
      pay: async (path, opts) => {
        payCalls.push({ path, opts });
        await new Promise((r) => setTimeout(r, 50));
        return paidOutcome();
      },
    }),
  );

  it("checks and prices an invoice, ignoring an address written on it", async () => {
    seedSession(200, 300_000);
    saveFreelancers([ada()]);
    const r = await upload("inv.json", JSON.stringify({ invoiceId: "INV-1", freelancer: "ada", amountNgn: 150000, payTo: "0x" + "9".repeat(40) }));
    const v = r.json();
    expect(r.status).toBe(200);
    expect(v.holds).toEqual([]);
    expect(v.price.usdtCost).toBeCloseTo(103.86, 1);
    expect(v.rows.map((x: { title: string }) => x.title)).toEqual([
      "Ada Obi is on your list",
      "Not paid before",
      "Within Ada's limit",
      "Within your per-invoice limit",
      "Within the agent's weekly limits",
      "Wallet address written on the invoice",
    ]);
    expect(v.rows[5]).toMatchObject({ ignored: true, ok: false });
  });

  it("holds an unknown payee, records it, and offers no way to pay", async () => {
    seedSession(200, 300_000);
    saveFreelancers([ada()]);
    const v = (await upload("x.txt.json", JSON.stringify({ invoiceId: "X-9", freelancer: "Ada O. Payments", amountNgn: 2_000_000 }))).json();
    expect(v.canOverride).toBe(false);
    expect(v.price).toBeNull();
    expect(loadHolds()).toHaveLength(1);
    const s = (await call("GET", "/api/state")).json();
    expect(s.payouts[0]).toMatchObject({ kind: "held", who: "Ada O. Payments", amountNgn: 2_000_000 });
  });

  it("blocks paying past the agent's weekly limit, without calling it a fraud hold", async () => {
    seedSession(50, 300_000);
    saveFreelancers([ada()]);
    const v = (await upload("inv.json", JSON.stringify({ invoiceId: "INV-2", freelancer: "ada", amountNgn: 150000 }))).json();
    expect(v.rows.find((x: { title: string }) => x.title === "Over the agent's weekly limits")).toBeTruthy();
    expect(v.canOverride).toBe(false);
    expect(loadHolds()).toEqual([]);
  });

  it("pays with the price the client approved, one payment at a time", async () => {
    seedSession(200, 300_000);
    saveFreelancers([ada()]);
    const { id } = (await upload("inv.json", JSON.stringify({ invoiceId: "INV-1", freelancer: "ada", amountNgn: 150000 }))).json();
    expect((await call("POST", `/api/invoices/${id}/pay`, { body: {} })).status).toBe(400);
    const [first, second] = await Promise.all([
      call("POST", `/api/invoices/${id}/pay`, { body: { approvedUsdt: 104.9 } }),
      new Promise((r) => setTimeout(r, 10)).then(() => call("POST", `/api/invoices/${id}/pay`, { body: { approvedUsdt: 104.9 } })),
    ]);
    expect(first.json()).toMatchObject({ status: "paid", freelancer: "Ada Obi", receipt: "INV-1-1.json" });
    expect(second.status).toBe(409);
    expect(payCalls).toHaveLength(1);
    expect(payCalls[0]!.opts).toEqual({ approvedUsdt: 104.9, approveHolds: false });
    expect((await call("POST", "/api/invoices/../../x/pay", { body: { approvedUsdt: 1 } })).status).not.toBe(200);
  });
});

void dir;
