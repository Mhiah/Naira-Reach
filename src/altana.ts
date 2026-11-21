// The client's side of Altana: a non-custodial wallet the client controls, and
// a session key the client grants to the agent with on-chain limits.
import {
  CELO,
  NATIVE_TOKEN,
  createClient,
  deserializeSession,
  serializeSession,
  signerFromPrivateKey,
  type CallPermission,
  type SerializedSession,
  type Session,
} from "@altananetwork/sdk";
import { existsSync, readFileSync } from "node:fs";
import { parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { DECIMALS, TEXTILE_REACTOR, TOKENS } from "./celo.ts";
import { readJson, statePath, writeJson } from "./config.ts";

const SESSION_FILE = () => statePath("session.json");
const SESSION_KEY_FILE = () => statePath("session.key");
const CLIENT_FILE = () => statePath("client.json");

/** Relay fees: USD₮ if the Celo relay accepts it, otherwise CELO. */
export const FEE_TOKENS = [TOKENS.USDT, NATIVE_TOKEN] as const;

export const AGENT_IDENTITY = {
  name: "Naira Reach",
  description: "Settles a client's invoice to a Nigerian freelancer in naira (cNGN) on Celo, privately and within limits the client sets.",
};

export type SessionLimits = {
  /** Most USD₮ the agent may spend per week, in whole units. */
  usdtPerWeek: number;
  /** Most cNGN the agent may send per week, in whole naira. */
  cngnPerWeek: number;
  /** How long the key lives, in days. */
  days: number;
  /** Optional ERC-5564 announcer the agent may call. */
  announcer?: Address;
};

/**
 * Exactly what the agent may call. Anything else reverts at validation time.
 *  - approve USD₮ (to the Textile reactor, for the swap)
 *  - the Textile reactor (the swap itself)
 *  - transfer cNGN (the payout)
 *  - transfer USD₮ (a few cents of gas money sent with each private payout)
 */
export function agentPermissions(limits: SessionLimits) {
  const calls: CallPermission[] = [
    { to: TOKENS.USDT, signature: "approve(address,uint256)" },
    { to: TEXTILE_REACTOR },
    { to: TOKENS.CNGN, signature: "transfer(address,uint256)" },
    { to: TOKENS.USDT, signature: "transfer(address,uint256)" },
  ];
  if (limits.announcer) calls.push({ to: limits.announcer, signature: "announce(uint256,address,bytes,bytes)" });
  return {
    calls,
    spend: [
      { token: TOKENS.USDT, limit: parseUnits(String(limits.usdtPerWeek), DECIMALS.USDT), period: "week" as const },
      { token: TOKENS.CNGN, limit: parseUnits(String(limits.cngnPerWeek), DECIMALS.CNGN), period: "week" as const },
    ],
  };
}

function altana() {
  return createClient({ chains: [CELO], agentIdentity: AGENT_IDENTITY });
}

/** Step 1 (client): create the wallet and make its first action, which also registers its ERC-8004 identity. */
export async function setupClientWallet(adminKey: Hex) {
  const client = altana();
  const signer = signerFromPrivateKey(adminKey);
  const wallet = await client.createWallet({ signer });
  writeJson(CLIENT_FILE(), { walletAddress: wallet.address });
  return { client, wallet, signer };
}

export async function activateClientWallet(adminKey: Hex) {
  const { client, wallet, signer } = await setupClientWallet(adminKey);
  const result = await client.execute({
    wallet,
    signer,
    calls: { to: wallet.address, value: 0n },
    feeToken: FEE_TOKENS,
  });
  return { wallet: wallet.address, result };
}

/** Step 2 (client): grant the agent a scoped session key. */
export async function grantAgentSession(adminKey: Hex, limits: SessionLimits) {
  const { client, wallet, signer } = await setupClientWallet(adminKey);
  // Our own key, saved before the grant, so a crash can never strand an authorized key.
  const sessionKey = generatePrivateKey();
  writeJson(SESSION_KEY_FILE(), { privateKey: sessionKey }, true);
  const sessionSigner = signerFromPrivateKey(sessionKey);
  const session = await client.grantSession({
    wallet,
    signer,
    sessionSigner,
    permissions: agentPermissions(limits),
    expiry: Math.floor(Date.now() / 1000) + limits.days * 86_400,
    feeToken: FEE_TOKENS,
  });
  if (session.status !== "granted") {
    throw new Error(`Grant failed: ${JSON.stringify(session.legs.filter((l) => l.status === "FAILED"))}`);
  }
  writeJson(SESSION_FILE(), serializeSession(session));
  return session;
}

/** Step 3 (client, any time): pull the agent's access. Effect is immediate. */
export async function revokeAgentSession(adminKey: Hex) {
  const { client, wallet, signer } = await setupClientWallet(adminKey);
  const session = loadAgentSession();
  return client.revokeSession({ wallet, signer, session, feeToken: FEE_TOKENS });
}

export function hasAgentSession(): boolean {
  return existsSync(SESSION_FILE()) && existsSync(SESSION_KEY_FILE());
}

/** The agent's side: rebuild the live session from local state. */
export function loadAgentSession(): Session {
  if (!hasAgentSession()) throw new Error("No agent session yet. The client runs `npm run reach -- session grant` first.");
  const stored = readJson<SerializedSession | null>(SESSION_FILE(), null);
  const { privateKey } = JSON.parse(readFileSync(SESSION_KEY_FILE(), "utf8")) as { privateKey: Hex };
  if (!stored) throw new Error("Session file is empty.");
  const session = deserializeSession(stored, signerFromPrivateKey(privateKey));
  if (session.expiry * 1000 <= Date.now()) throw new Error("The agent's session has expired. The client grants a new one.");
  return session;
}

export function clientWalletAddress(): Address | undefined {
  return readJson<{ walletAddress?: Address }>(CLIENT_FILE(), {}).walletAddress;
}
