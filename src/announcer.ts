// ERC-5564 announcements: after each private payout, a small public record
// (one-time public key + view tag) goes on Celo. The freelancer's browser reads
// these with its own viewing key and finds its payouts without any receipt.
// Nobody else can tell which announcement belongs to whom.
import { encodeFunctionData, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { TOKENS } from "./celo.ts";
import type { Call } from "./executor.ts";
import { erc20Metadata, SCHEME_ID, type StealthPayout } from "./stealth.ts";

/** The standard ERC-5564 announcer, at the same address as on Ethereum, Base, Arbitrum and others. */
export const ERC5564_ANNOUNCER: Address = "0x55649E01B5Df198D18D95b5cc5051630cfD45564";

/** The deterministic CREATE2 deployer present on Celo and most EVM chains. */
export const CREATE2_FACTORY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/**
 * Salt + creation code exactly as broadcast on other chains by ScopeLift's
 * stealth-address-erc-contracts (script/Deploy.s.sol). Sent to CREATE2_FACTORY,
 * it creates the announcer at ERC5564_ANNOUNCER. Checked in test/announcer.test.ts.
 */
export const ANNOUNCER_DEPLOY_DATA: Hex = "0xd0103a290d760f027c9ca72675f5121d725397fb2f618f05b6c44958b25b4447608060405234801561001057600080fd5b506102c5806100206000396000f3fe608060405234801561001057600080fd5b506004361061002b5760003560e01c80634d1f958314610030575b600080fd5b61004361003e36600461018d565b610045565b005b3373ffffffffffffffffffffffffffffffffffffffff168373ffffffffffffffffffffffffffffffffffffffff16857f5f0eab8057630ba7676c49b4f21a0231414e79474595be8e4c432fbf6bf0f4e785856040516100a592919061028a565b60405180910390a450505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b600082601f8301126100f357600080fd5b813567ffffffffffffffff8082111561010e5761010e6100b3565b604051601f83017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0908116603f01168101908282118183101715610154576101546100b3565b8160405283815286602085880101111561016d57600080fd5b836020870160208301376000602085830101528094505050505092915050565b600080600080608085870312156101a357600080fd5b84359350602085013573ffffffffffffffffffffffffffffffffffffffff811681146101ce57600080fd5b9250604085013567ffffffffffffffff808211156101eb57600080fd5b6101f7888389016100e2565b9350606087013591508082111561020d57600080fd5b5061021a878288016100e2565b91505092959194509250565b6000815180845260005b8181101561024c57602081850181015186830182015201610230565b5060006020828601015260207fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f83011685010191505092915050565b60408152600061029d6040830185610226565b82810360208401526102af8185610226565b9594505050505056fea164736f6c6343000817000a";

/** Naira Reach announced nothing before this block, so the freelancer's scan starts here. */
export const ANNOUNCEMENTS_FROM_BLOCK = 83_420_000n;

export const ANNOUNCER_ABI = parseAbi(["function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)"]);
export const ANNOUNCEMENT_EVENT = parseAbiItem(
  "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)",
);

export function announceCall(payout: Pick<StealthPayout, "stealthAddress" | "ephemeralPublicKey" | "viewTag">, amount: bigint, token: Address = TOKENS.CNGN): Call {
  return {
    to: ERC5564_ANNOUNCER,
    data: encodeFunctionData({
      abi: ANNOUNCER_ABI,
      functionName: "announce",
      args: [SCHEME_ID, payout.stealthAddress, payout.ephemeralPublicKey, erc20Metadata(payout.viewTag, amount, token)],
    }),
    label: "announce",
  };
}

export function deployCall(): Call {
  return { to: CREATE2_FACTORY, data: ANNOUNCER_DEPLOY_DATA, label: "deploy announcer" };
}

export async function announcerLive(reader: PublicClient): Promise<boolean> {
  const code = await reader.getCode({ address: ERC5564_ANNOUNCER });
  return Boolean(code && code !== "0x");
}
