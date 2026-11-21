import { describe, expect, it } from "vitest";
import { concat, encodeFunctionData, erc20Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toDataSuffix } from "@celo/attribution-tags";
import { readTag, tagCalldata } from "../src/tag.ts";
import { generateMetaKeys, isMine, newStealthAddress, parseMetaAddress, stealthPrivateKey } from "../src/stealth.ts";
import { checkCost, checkInvoice, type Freelancer } from "../src/checks.ts";
import { fingerprint, redact, validateInvoice } from "../src/invoice.ts";
import { agentPermissions } from "../src/altana.ts";
import { TEXTILE_REACTOR, TOKENS } from "../src/celo.ts";

const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: ["0x000000000000000000000000000000000000dEaD", 5n] });

describe("attribution tag", () => {
  it("appends the enrolled code to calldata", () => {
    const tagged = tagCalldata(transfer, "celo_test123");
    expect(tagged.startsWith(transfer)).toBe(true);
    expect(readTag(tagged)).toEqual(["celo_test123"]);
  });

  it("merges into an existing suffix instead of stacking a second one", () => {
    const already = concat([transfer, toDataSuffix("textile_partner")]);
    const tagged = tagCalldata(already, "celo_test123");
    expect(readTag(tagged)).toEqual(["textile_partner", "celo_test123"]);
    expect(tagged.match(/80218021802180218021802180218021/g)?.length).toBe(1);
  });

  it("does not repeat a code that is already there", () => {
    const once = tagCalldata(transfer, "celo_test123");
    expect(tagCalldata(once, "celo_test123")).toBe(once);
  });

  it("tags empty calldata", () => {
    expect(readTag(tagCalldata("0x", "celo_x"))).toEqual(["celo_x"]);
  });
});

describe("private payouts (ERC-5564)", () => {
  it("derives an address only the freelancer can open", () => {
    const keys = generateMetaKeys();
    const p = newStealthAddress(keys.metaAddress);
    const key = stealthPrivateKey(keys.spendingPrivateKey, keys.viewingPrivateKey, p.ephemeralPublicKey);
    expect(privateKeyToAccount(key).address).toBe(p.stealthAddress);
    expect(isMine(p, parseMetaAddress(keys.metaAddress).spendingPublicKey, keys.viewingPrivateKey)).toBe(true);
  });

  it("gives a different address every time, so payouts cannot be linked", () => {
    const keys = generateMetaKeys();
    const a = newStealthAddress(keys.metaAddress).stealthAddress;
    const b = newStealthAddress(keys.metaAddress).stealthAddress;
    expect(a).not.toBe(b);
  });

  it("someone else's keys cannot claim it", () => {
    const mine = generateMetaKeys();
    const other = generateMetaKeys();
    const p = newStealthAddress(mine.metaAddress);
    expect(isMine(p, parseMetaAddress(other.metaAddress).spendingPublicKey, other.viewingPrivateKey)).toBe(false);
    const wrong = stealthPrivateKey(other.spendingPrivateKey, other.viewingPrivateKey, p.ephemeralPublicKey);
    expect(privateKeyToAccount(wrong).address).not.toBe(p.stealthAddress);
  });

  it("rejects malformed meta-addresses", () => {
    expect(() => parseMetaAddress("st:celo:0x1234")).toThrow();
    expect(() => parseMetaAddress("0x" + "11".repeat(66))).toThrow();
  });
});

describe("invoice privacy", () => {
  it("strips contact and bank details before the AI reader sees them", () => {
    const text = "Pay Ada at ada@mail.com, 08031234567, GTBank 0123456789, or 0x1111111111111111111111111111111111111111. Total ₦150,000";
    const out = redact(text);
    expect(out).not.toMatch(/ada@mail\.com|08031234567|0123456789|0x1111/);
    expect(out).toContain("₦150,000");
  });

  it("fingerprints the exact invoice bytes", () => {
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
    expect(fingerprint("a")).toBe(fingerprint("a"));
  });

  it("refuses invoices without the basics", () => {
    expect(() => validateInvoice({ freelancer: "ada", amountNgn: 10 })).toThrow(/invoiceId/);
    expect(() => validateInvoice({ invoiceId: "1", freelancer: "ada", amountNgn: -5 })).toThrow(/positive/);
  });
});

describe("checks before money moves", () => {
  const ada: Freelancer = { id: "ada", name: "Ada Obi", aliases: ["Ada O."], metaAddress: generateMetaKeys().metaAddress, maxInvoiceNgn: 200_000 };
  const inv = (amountNgn: number, invoiceId = "INV-1", freelancer = "Ada O.") => ({ invoiceId, freelancer, amountNgn });
  const fp = "0xabc" as Hex;

  it("passes a normal invoice", () => {
    expect(checkInvoice(inv(150_000), fp, [ada], []).holds).toEqual([]);
  });

  it("holds an unknown freelancer", () => {
    expect(checkInvoice(inv(1, "X", "Mallory"), fp, [ada], []).holds[0]).toMatch(/not on your approved/);
  });

  it("holds a duplicate by number and by fingerprint", () => {
    const ledger = [{ invoiceId: "inv-1", freelancerId: "ada", fingerprint: "0xdef" as Hex, amountNgn: 1, paidAt: "", receipt: "" }];
    expect(checkInvoice(inv(150_000), fp, [ada], ledger).holds.join()).toMatch(/already been paid/);
    const sameFile = [{ ...ledger[0]!, invoiceId: "other", fingerprint: fp }];
    expect(checkInvoice(inv(150_000, "INV-9"), fp, [ada], sameFile).holds.join()).toMatch(/exact invoice/);
  });

  it("holds amounts above the freelancer's limit or off the agreed figure", () => {
    expect(checkInvoice(inv(250_000), fp, [ada], []).holds.join()).toMatch(/above this freelancer's limit/);
    expect(checkInvoice(inv(100_000), fp, [{ ...ada, agreedNgn: 120_000 }], []).holds.join()).toMatch(/differs from the agreed/);
  });

  it("holds a cost above the client's dollar ceiling", () => {
    expect(checkCost(120, 100)).toHaveLength(1);
    expect(checkCost(80, 100)).toHaveLength(0);
  });
});

describe("agent permissions", () => {
  it("only allows the calls a payout needs, with weekly caps on both tokens", () => {
    const p = agentPermissions({ usdtPerWeek: 200, cngnPerWeek: 300_000, days: 7 });
    expect(p.calls).toEqual([
      { to: TOKENS.USDT, signature: "approve(address,uint256)" },
      { to: TEXTILE_REACTOR },
      { to: TOKENS.CNGN, signature: "transfer(address,uint256)" },
      { to: TOKENS.USDT, signature: "transfer(address,uint256)" },
    ]);
    expect(p.spend).toEqual([
      { token: TOKENS.USDT, limit: 200_000_000n, period: "week" },
      { token: TOKENS.CNGN, limit: 300_000_000_000n, period: "week" },
    ]);
  });
});
