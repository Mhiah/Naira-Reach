// The agent's public ERC-8004 profile. When the wallet is set up, Altana registers
// the identity with a placeholder profile: Altana's icon, and Altana's explorer as
// the only link. This replaces it with Naira Reach's own profile, sent once by the
// client's own wallet (the only address the registry lets change it).
import { createClient, encodeFunctionData, getAddress, http, parseAbi, type Address, type Client, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readContract, sendTransaction, waitForTransactionReceipt } from "viem/actions";
import { celo } from "viem/chains";
import { CELO_CHAIN_ID, ERC8004_IDENTITY_REGISTRY, USDT_FEE_CURRENCY } from "./celo.ts";
import { tagCalldata } from "./tag.ts";

export const SITE_URL = "https://nairareach.myacxt.site";
export const PROFILE_IMAGE = `${SITE_URL}/agent-logo.png`;

export const IDENTITY_ABI = parseAbi([
  "function tokenURI(uint256 agentId) view returns (string)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function setAgentURI(uint256 agentId, string newURI)",
]);

/** The ERC-8004 registration file for one wallet's agent (registration-v1). */
export function agentRegistration(agentId: string | number | bigint) {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Naira Reach",
    description:
      "Pays a Nigerian freelancer for a client abroad, in naira on Celo. It checks the invoice, converts the client's USD₮ to cNGN through Textile FX, and pays the exact naira billed to a private address only the freelancer can open. It works from the client's own Altana wallet, under a session key with weekly caps, a list of allowed calls and an expiry.",
    image: PROFILE_IMAGE,
    services: [{ name: "web", endpoint: SITE_URL }],
    x402Support: false,
    active: true,
    registrations: [{ agentId: Number(agentId), agentRegistry: `eip155:${CELO_CHAIN_ID}:${ERC8004_IDENTITY_REGISTRY}` }],
    supportedTrust: ["reputation"],
  };
}

/** The profile as an onchain data: URI, so it doesn't depend on any server staying up. */
export function registrationUri(agentId: string | number | bigint): string {
  const json = JSON.stringify(agentRegistration(agentId));
  const b64 = typeof Buffer !== "undefined" ? Buffer.from(json, "utf8").toString("base64") : btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return `data:application/json;base64,${b64}`;
}

/** Reads the profile URI the registry holds now. */
export async function currentAgentUri(reader: Client, agentId: string | number | bigint): Promise<string> {
  return readContract(reader, { address: ERC8004_IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "tokenURI", args: [BigInt(agentId)] });
}

export function profileCalldata(agentId: string | number | bigint, code?: string | null): Hex {
  const data = encodeFunctionData({ abi: IDENTITY_ABI, functionName: "setAgentURI", args: [BigInt(agentId), registrationUri(agentId)] });
  return code ? tagCalldata(data, code) : data;
}

/**
 * Sends the profile update from the client's own wallet. Nothing is sent if the
 * wallet doesn't own the identity, or if the registry already holds this profile.
 */
export async function updateAgentProfile(args: {
  adminKey: Hex;
  rpcUrl: string;
  agentId: string;
  code?: string | null;
  reader?: Client;
}): Promise<{ status: "updated" | "unchanged"; hash?: Hex; agentId: string }> {
  const account = privateKeyToAccount(args.adminKey);
  const chain = createClient({ account, chain: celo, transport: http(args.rpcUrl) });
  const reader = (args.reader ?? chain) as Client;
  const id = BigInt(args.agentId);
  const owner = await readContract(reader, { address: ERC8004_IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "ownerOf", args: [id] });
  if (getAddress(owner) !== account.address) throw new Error(`Agent #${args.agentId} belongs to another wallet, so this wallet can't change its profile.`);
  if ((await currentAgentUri(reader, id)) === registrationUri(id)) return { status: "unchanged", agentId: args.agentId };
  const hash = await sendTransaction(chain, {
    account,
    chain: celo,
    to: ERC8004_IDENTITY_REGISTRY as Address,
    data: profileCalldata(id, args.code),
    feeCurrency: USDT_FEE_CURRENCY,
  });
  const r = await waitForTransactionReceipt(reader, { hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`The profile update failed on-chain: ${hash}`);
  return { status: "updated", hash, agentId: args.agentId };
}
