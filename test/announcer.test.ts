import { getContractAddress, keccak256, slice, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { announceCall, ANNOUNCER_DEPLOY_DATA, CREATE2_FACTORY, deployCall, ERC5564_ANNOUNCER } from "../src/announcer.ts";
import { generateMetaKeys, isMine, newStealthAddress, parseMetaAddress } from "../src/stealth.ts";

describe("announcer", () => {
  it("deploys at the standard ERC-5564 address", () => {
    const salt = slice(ANNOUNCER_DEPLOY_DATA, 0, 32);
    const initcode = slice(ANNOUNCER_DEPLOY_DATA, 32);
    expect(getContractAddress({ opcode: "CREATE2", from: CREATE2_FACTORY, salt, bytecodeHash: keccak256(initcode) })).toBe(ERC5564_ANNOUNCER);
    expect(deployCall()).toMatchObject({ to: CREATE2_FACTORY, data: ANNOUNCER_DEPLOY_DATA });
  });

  it("announces what only the freelancer's keys can recognise", () => {
    const keys = generateMetaKeys();
    const other = generateMetaKeys();
    const p = newStealthAddress(keys.metaAddress);
    const call = announceCall(p, 2000_000000n);
    expect(call.to).toBe(ERC5564_ANNOUNCER);
    expect(call.data.slice(0, 10)).toBe(toFunctionSelector("announce(uint256,address,bytes,bytes)"));
    expect(isMine(p, parseMetaAddress(keys.metaAddress).spendingPublicKey, keys.viewingPrivateKey)).toBe(true);
    expect(isMine(p, parseMetaAddress(other.metaAddress).spendingPublicKey, other.viewingPrivateKey)).toBe(false);
  });
});
