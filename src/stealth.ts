// Private payouts with ERC-5564 stealth addresses (scheme 1, secp256k1 + view tags).
//
// The freelancer creates two key pairs once and shares only the public halves as a
// "stealth meta-address" (st:celo:0x<spending pub><viewing pub>). For every invoice
// the agent derives a brand-new address from it. Only the freelancer can find and
// spend from that address, and outsiders cannot link one payout to the next.
//
// Math (matches the ERC-5564 reference SDK):
//   shared  = ecdh(ephemeralPriv, viewingPub)        (33-byte compressed point)
//   h       = keccak256(shared); viewTag = h[0]
//   address = pubToAddress(spendingPub + h·G)
//   key     = (spendingPriv + h) mod n                 (freelancer side)
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, encodePacked, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { TOKENS } from "./celo.ts";

export const SCHEME_ID = 1n;
const Point = secp256k1.ProjectivePoint;
const N = secp256k1.CURVE.n;

export type MetaKeys = {
  spendingPrivateKey: Hex;
  viewingPrivateKey: Hex;
  metaAddress: string;
};

export type StealthPayout = {
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag: Hex;
};

const randomKey = (): Uint8Array => secp256k1.utils.randomPrivateKey();
const pub = (priv: Uint8Array | Hex) => secp256k1.getPublicKey(typeof priv === "string" ? hexToBytes(priv) : priv, true);

/** Freelancer, once: make the two key pairs and the shareable meta-address. */
export function generateMetaKeys(chain = "celo"): MetaKeys {
  const spending = randomKey();
  const viewing = randomKey();
  return {
    spendingPrivateKey: bytesToHex(spending),
    viewingPrivateKey: bytesToHex(viewing),
    metaAddress: `st:${chain}:0x${bytesToHex(pub(spending)).slice(2)}${bytesToHex(pub(viewing)).slice(2)}`,
  };
}

export function parseMetaAddress(uri: string): { spendingPublicKey: Hex; viewingPublicKey: Hex } {
  const raw = uri.startsWith("0x") ? uri : uri.split(":")[2];
  if (!uri.startsWith("0x") && (uri.split(":").length !== 3 || !uri.startsWith("st:"))) {
    throw new Error("A stealth meta-address looks like st:celo:0x… .");
  }
  const hex = (raw ?? "").slice(2);
  if (!/^[0-9a-fA-F]{132}$/.test(hex)) throw new Error("Stealth meta-address must hold two 33-byte public keys.");
  const spendingPublicKey = `0x${hex.slice(0, 66)}` as Hex;
  const viewingPublicKey = `0x${hex.slice(66)}` as Hex;
  // Throws if either is not a point on the curve.
  Point.fromHex(spendingPublicKey.slice(2));
  Point.fromHex(viewingPublicKey.slice(2));
  return { spendingPublicKey, viewingPublicKey };
}

function hashedSecret(priv: Uint8Array | Hex, otherPub: Hex): Hex {
  const p = typeof priv === "string" ? hexToBytes(priv) : priv;
  return keccak256(secp256k1.getSharedSecret(p, hexToBytes(otherPub), true));
}

/** Agent, per invoice: a fresh address only the freelancer can open. */
export function newStealthAddress(metaAddress: string, ephemeralPrivateKey: Uint8Array = randomKey()): StealthPayout {
  const { spendingPublicKey, viewingPublicKey } = parseMetaAddress(metaAddress);
  const h = hashedSecret(ephemeralPrivateKey, viewingPublicKey);
  const stealthPoint = Point.fromHex(spendingPublicKey.slice(2)).add(Point.BASE.multiply(BigInt(h) % N));
  return {
    stealthAddress: publicKeyToAddress(bytesToHex(stealthPoint.toRawBytes(false))),
    ephemeralPublicKey: bytesToHex(pub(ephemeralPrivateKey)),
    viewTag: `0x${h.slice(2, 4)}` as Hex,
  };
}

/** Freelancer: is this payout mine? Uses only the viewing key, so it can run on a watch-only device. */
export function isMine(p: StealthPayout, spendingPublicKey: Hex, viewingPrivateKey: Hex): boolean {
  const h = hashedSecret(viewingPrivateKey, p.ephemeralPublicKey);
  if (`0x${h.slice(2, 4)}`.toLowerCase() !== p.viewTag.toLowerCase()) return false;
  const point = Point.fromHex(spendingPublicKey.slice(2)).add(Point.BASE.multiply(BigInt(h) % N));
  return publicKeyToAddress(bytesToHex(point.toRawBytes(false))).toLowerCase() === p.stealthAddress.toLowerCase();
}

/** Freelancer: the private key that controls one payout address. */
export function stealthPrivateKey(spendingPrivateKey: Hex, viewingPrivateKey: Hex, ephemeralPublicKey: Hex): Hex {
  const h = hashedSecret(viewingPrivateKey, ephemeralPublicKey);
  const key = (BigInt(spendingPrivateKey) + BigInt(h)) % N;
  return `0x${key.toString(16).padStart(64, "0")}` as Hex;
}

/** ERC-5564 metadata for an ERC-20 transfer: view tag, transfer selector, token, amount. */
export function erc20Metadata(viewTag: Hex, amount: bigint, token: Address = TOKENS.CNGN): Hex {
  return encodePacked(["bytes1", "bytes4", "address", "uint256"], [viewTag, "0xa9059cbb", token, amount]);
}
