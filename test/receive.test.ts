import { describe, expect, it } from "vitest";
import { checkKeys, newKeys, openReceipt } from "../src/browser/receive.ts";
import { newStealthAddress } from "../src/stealth.ts";

const receiptFor = (metaAddress: string) => {
  const p = newStealthAddress(metaAddress);
  return {
    product: "Naira Reach",
    paidAt: "2026-11-21T10:00:00Z",
    invoice: { invoiceId: "INV-1", freelancerId: "ada", amountNgn: 150000, fingerprint: "0x01" },
    payout: { ...p, cngn: 150000, gasMoneyUsdt: 0.05 },
    wallet: { kind: "altana", address: "0x1234567890abcdef1234567890abcdef12345678" },
    transactions: [{ hash: "0x" + "ab".repeat(32) }],
  };
};

describe("Receive side in the browser", () => {
  it("opens a payout made to our code, and only ours", () => {
    const mine = newKeys();
    const someoneElse = newKeys();
    const r = receiptFor(mine.metaAddress);
    const opened = openReceipt(r, mine);
    expect(opened).toMatchObject({ invoiceId: "INV-1", amountNgn: 150000, stealthAddress: r.payout.stealthAddress, gasMoneyUsdt: 0.05 });
    expect(() => openReceipt(r, someoneElse)).toThrow(/not made to your receiving code/);
    expect(() => openReceipt({ hello: 1 }, mine)).toThrow(/not a Naira Reach receipt/);
  });

  it("accepts a matching key backup and rejects a tampered one", () => {
    const k = newKeys();
    expect(checkKeys(JSON.parse(JSON.stringify(k)))).toEqual(k);
    expect(() => checkKeys({ ...k, viewingPrivateKey: newKeys().viewingPrivateKey })).toThrow(/don't match/);
    expect(() => checkKeys({ nope: true })).toThrow(/not a Naira Reach key backup/);
  });
});
