// The agent's key as Celo sees it: a key the wallet no longer holds (replaced or
// revoked, perhaps from another browser) is shown as such and can't start a payment,
// and the raw failures a client can hit while paying come back as plain sentences.
import { beforeEach, describe, expect, it } from "vitest";
import { ContractFunctionRevertedError, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createAgent, friendlyPayError, KEY_GONE } from "../src/agent.ts";
import { TOKENS } from "../src/celo.ts";
import { store } from "../src/store.ts";
import type { TextileClient } from "../src/textile.ts";
import { freshState } from "./helpers.ts";

const WALLET = "0xB2441B175d620A3Fd5CDef28fA1c6957e6224431";
const T = Date.parse("2026-11-26T20:00:00Z");

function withSession() {
  const key = generatePrivateKey();
  const pub = privateKeyToAccount(key).publicKey;
  store().write("session.key", { privateKey: key }, true);
  store().write("client.json", { walletAddress: WALLET, activatedAt: "2026-11-20T09:00:00Z" });
  store().write("session.json", {
    walletAddress: WALLET,
    publicKey: pub,
    permissions: { spend: [{ token: TOKENS.USDT, limit: "200000000", period: "week" }, { token: TOKENS.CNGN, limit: "300000000000", period: "week" }], calls: [] },
    expiry: Math.floor(T / 1000) + 20 * 86_400,
  });
}

function agent(getKey: "held" | "gone" | "unreachable") {
  let calls = 0;
  const reader = {
    readContract: async (a: { functionName: string }) => {
      if (a.functionName !== "getKey") return 0n;
      calls++;
      if (getKey === "gone") throw new ContractFunctionRevertedError({ abi: [], functionName: "getKey" });
      if (getKey === "unreachable") throw new Error("fetch failed");
      return { expiry: 0, keyType: 2, isSuperAdmin: false, publicKey: "0x" };
    },
    getBalance: async () => 0n,
    getCode: async () => "0x",
  } as unknown as PublicClient;
  const a = createAgent({
    textile: { preview: async () => ({ takerPays: "69300000", feeAmount: "14000" }) } as unknown as TextileClient,
    textileKeyless: true,
    reader,
    adminKey: () => ("0x" + "4c".repeat(32)) as `0x${string}`,
    hasAdminKey: () => true,
    attributionCode: () => "celo_test",
    maxInvoiceUsdt: 500,
    gasTopUpUsdt: 0.05,
    actions: { pay: async () => { throw new Error("should not pay"); } },
    now: () => T,
  });
  return { a, calls: () => calls };
}

beforeEach(() => {
  freshState();
  withSession();
});

describe("the agent's key, as Celo sees it", () => {
  it("is active while the wallet holds it", async () => {
    const s = (await agent("held").a.dispatch("GET", "/state")) as any;
    expect(s.session).toMatchObject({ expired: false, gone: false, usdtPerWeek: 200 });
  });

  it("shows as replaced or revoked when the wallet no longer holds it, and refuses to pay with it", async () => {
    const { a } = agent("gone");
    const s = (await a.dispatch("GET", "/state")) as any;
    expect(s.session).toMatchObject({ expired: true, gone: true });
    await expect(a.dispatch("POST", "/invoices/abc/pay", { approvedUsdt: 2 })).rejects.toThrow(KEY_GONE);
  });

  it("isn't called gone just because Celo couldn't be reached", async () => {
    const s = (await agent("unreachable").a.dispatch("GET", "/state")) as any;
    expect(s.session).toMatchObject({ expired: false, gone: false });
  });

  it("asks Celo at most once a minute", async () => {
    const { a, calls } = agent("held");
    await a.dispatch("GET", "/state");
    await a.dispatch("GET", "/state");
    expect(calls()).toBe(1);
  });
});

describe("plain words for payment failures", () => {
  it("explains an unknown key hash", () => {
    expect(friendlyPayError("Key hash 0x66cd923f46c284319c8f5395c1c2856c6d9522138063b1c5feb68e09901ffd8e is unknown. Try again; the debug log has the whole failure.")).toBe(KEY_GONE);
  });
  it("explains Textile not locking in a price", () => {
    expect(friendlyPayError("No firm quote (no_quote: no_valid_quote).")).toMatch(/market makers didn't lock in a price.*nothing was sent.*Approve and pay again/);
    expect(friendlyPayError("No firm quote (expired).")).toMatch(/didn't give a firm price.*\(expired\)/);
  });
  it("leaves other messages alone", () => {
    expect(friendlyPayError("Approve a price first.")).toBe("Approve a price first.");
  });
});
