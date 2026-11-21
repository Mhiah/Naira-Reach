// Keyless Textile quotes: the paying wallet proves it is in control by signing
// "Textile Taker Control" typed data (docs.textilecredit.com/api/v2/authentication.html).
//
// - A plain wallet (--direct) signs a fresh proof for every quote.
// - An Altana wallet is an EIP-7702 account: its address is the client's own key.
//   The client signs one proof with a nonce secret when granting the session, and
//   Textile accepts it for firm quotes for about 12 hours. `proof refresh` renews it.
import { bytesToHex, getAddress, keccak256, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import { readJson, statePath, writeJson } from "./config.ts";

export type TakerProof = {
  nonce: Hex;
  issuedAt: number;
  signature: Hex;
  scheme?: "eip712";
  nonceSecret?: Hex;
};

/** Textile grants firm quotes about 12 hours on a nonce-secret proof; renew a little before. */
export const STORED_PROOF_MAX_AGE_MS = 11 * 60 * 60 * 1000;

const PROOF_FILE = () => statePath("taker-proof.json");

export function takerControlTypedData(taker: Address, chainId: number, nonce: Hex, issuedAt: number) {
  return {
    domain: { name: "Textile Taker Control", version: "1", chainId },
    types: {
      TakerControl: [
        { name: "taker", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType: "TakerControl" as const,
    message: { taker: getAddress(taker), chainId: BigInt(chainId), nonce, issuedAt: BigInt(issuedAt) },
  };
}

const random32 = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

/** Sign a proof for `taker` with a local key. With `longLived`, it carries a nonce secret. */
export async function signTakerProof(
  account: LocalAccount,
  taker: Address,
  chainId: number,
  opts: { longLived?: boolean; now?: number } = {},
): Promise<TakerProof> {
  const issuedAt = opts.now ?? Date.now();
  const secret = opts.longLived ? random32() : undefined;
  const nonce = secret ? keccak256(secret) : random32();
  const signature = await account.signTypedData(takerControlTypedData(taker, chainId, nonce, issuedAt));
  return { nonce, issuedAt, signature, scheme: "eip712", ...(secret ? { nonceSecret: secret } : {}) };
}

export function saveStoredProof(proof: TakerProof & { taker: Address; chainId: number }): void {
  writeJson(PROOF_FILE(), proof, true);
}

/** When the stored proof was signed and for which wallet, without handing out the proof. */
export function storedProofInfo(): { taker: Address; issuedAt: number; validUntil: number } | undefined {
  const p = readJson<(TakerProof & { taker: Address }) | null>(PROOF_FILE(), null);
  return p ? { taker: p.taker, issuedAt: p.issuedAt, validUntil: p.issuedAt + STORED_PROOF_MAX_AGE_MS } : undefined;
}

/** The client's stored proof for the Altana wallet, if it is still fresh. */
export function loadStoredProof(taker: Address, chainId: number, now = Date.now()): TakerProof {
  const p = readJson<(TakerProof & { taker: Address; chainId: number }) | null>(PROOF_FILE(), null);
  if (!p || getAddress(p.taker) !== getAddress(taker) || p.chainId !== chainId) {
    throw new Error("No Textile proof for this wallet. The client runs `proof refresh`.");
  }
  if (now - p.issuedAt > STORED_PROOF_MAX_AGE_MS) {
    throw new Error("The client's Textile proof is older than 11 hours. The client runs `proof refresh`.");
  }
  const { taker: _t, chainId: _c, ...proof } = p;
  return proof;
}
