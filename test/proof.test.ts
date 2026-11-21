import { beforeEach, describe, expect, it } from "vitest";
import { keccak256, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadStoredProof, saveStoredProof, signTakerProof, STORED_PROOF_MAX_AGE_MS, takerControlTypedData } from "../src/proof.ts";
import { freshState } from "./helpers.ts";

describe("Textile taker proof (keyless quotes)", () => {
  beforeEach(() => {
    freshState();
  });

  it("signs Textile Taker Control typed data that verifies as the wallet", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const p = await signTakerProof(account, account.address, 42220);
    const ok = await verifyTypedData({
      address: account.address,
      ...takerControlTypedData(account.address, 42220, p.nonce, p.issuedAt),
      signature: p.signature,
    });
    expect(ok).toBe(true);
    expect(p.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(p.nonceSecret).toBeUndefined();
  });

  it("a long-lived proof's nonce is the hash of its secret", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const p = await signTakerProof(account, account.address, 42220, { longLived: true });
    expect(p.nonceSecret).toBeDefined();
    expect(p.nonce).toBe(keccak256(p.nonceSecret!));
  });

  it("a stored proof is used only for its own wallet and only while fresh", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const p = await signTakerProof(account, account.address, 42220, { longLived: true, now: 1_000 });
    saveStoredProof({ ...p, taker: account.address, chainId: 42220 });
    expect(loadStoredProof(account.address, 42220, 2_000).signature).toBe(p.signature);
    expect(() => loadStoredProof(privateKeyToAccount(generatePrivateKey()).address, 42220, 2_000)).toThrow(/No Textile proof/);
    expect(() => loadStoredProof(account.address, 42220, 1_000 + STORED_PROOF_MAX_AGE_MS + 1)).toThrow(/older than 11 hours/);
  });
});
