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
import { parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CELO_CHAIN_ID, DECIMALS, TEXTILE_REACTOR, TOKENS } from "./celo.ts";
import { moveRecord, store } from "./store.ts";
import { saveStoredProof, signTakerProof } from "./proof.ts";

const SESSION = "session.json";
const SESSION_KEY = "session.key";
const CLIENT = "client.json";

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

/** What this computer knows about the client's wallet. No keys. */
export type ClientRecord = { walletAddress?: Address; activatedAt?: string; activationTx?: Hex; agentId?: string };

export const loadClientRecord = () => store().read<ClientRecord>(CLIENT, {});
const saveClientRecord = (patch: ClientRecord) => store().write(CLIENT, { ...loadClientRecord(), ...patch });

/** Step 1 (client): create the wallet and make its first action, which also registers its ERC-8004 identity. */
export async function setupClientWallet(adminKey: Hex) {
  const client = altana();
  const signer = signerFromPrivateKey(adminKey);
  const wallet = await client.createWallet({ signer });
  saveClientRecord({ walletAddress: wallet.address });
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
  if (result.status === "CONFIRMED") {
    saveClientRecord({
      activatedAt: new Date().toISOString(),
      activationTx: result.transactionHash,
      ...(result.agentIdentity?.status === "registered" ? { agentId: result.agentIdentity.agentId } : {}),
    });
  }
  return { wallet: wallet.address, result };
}

/** Step 2 (client): grant the agent a scoped session key. */
export async function grantAgentSession(adminKey: Hex, limits: SessionLimits) {
  const { client, wallet, signer } = await setupClientWallet(adminKey);
  // Our own key, saved before the grant, so a crash can never strand an authorized key.
  const sessionKey = generatePrivateKey();
  store().write(SESSION_KEY, { privateKey: sessionKey }, true);
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
  store().write(SESSION, serializeSession(session));
  await refreshTakerProof(adminKey);
  return session;
}

/**
 * Client: sign Textile's taker proof for the Altana wallet. The wallet is an
 * EIP-7702 account, so its address is the client's own key and that key's
 * signature proves control. Valid for firm quotes for about 12 hours.
 */
export async function refreshTakerProof(adminKey: Hex) {
  const account = privateKeyToAccount(adminKey);
  const wallet = clientWalletAddress();
  if (wallet && wallet.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`This key controls ${account.address}, not the Altana wallet ${wallet}.`);
  }
  const proof = await signTakerProof(account, account.address, CELO_CHAIN_ID, { longLived: true });
  saveStoredProof({ ...proof, taker: account.address, chainId: CELO_CHAIN_ID });
  return proof;
}

/** Step 3 (client, any time): pull the agent's access. Effect is immediate. */
export async function revokeAgentSession(adminKey: Hex) {
  const { client, wallet, signer } = await setupClientWallet(adminKey);
  const session = loadAgentSession();
  const result = await client.revokeSession({ wallet, signer, session, feeToken: FEE_TOKENS });
  if (result.status === "revoked" || result.status === "CONFIRMED") {
    // The key is dead on-chain. Move it out of the way so nothing tries to use it again.
    const dir = `revoked/${Date.now()}`;
    moveRecord(SESSION, `${dir}/session.json`);
    moveRecord(SESSION_KEY, `${dir}/session.key`, true);
  }
  return result;
}

export function hasAgentSession(): boolean {
  return store().exists(SESSION) && store().exists(SESSION_KEY);
}

/** The stored half of the session (limits and expiry, no key), for showing the client. */
export function storedSession(): SerializedSession | undefined {
  return hasAgentSession() ? (store().read<SerializedSession | null>(SESSION, null) ?? undefined) : undefined;
}

/** The agent's side: rebuild the live session from local state. */
export function loadAgentSession(): Session {
  if (!hasAgentSession()) throw new Error("No agent session yet. The client runs `npm run reach -- session grant` first.");
  const stored = store().read<SerializedSession | null>(SESSION, null);
  const { privateKey } = store().read<{ privateKey: Hex }>(SESSION_KEY, { privateKey: "0x" });
  if (!stored) throw new Error("Session file is empty.");
  const session = deserializeSession(stored, signerFromPrivateKey(privateKey));
  if (session.expiry * 1000 <= Date.now()) throw new Error("The agent's session has expired. The client grants a new one.");
  return session;
}

export function clientWalletAddress(): Address | undefined {
  return loadClientRecord().walletAddress;
}
