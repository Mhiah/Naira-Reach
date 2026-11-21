// Celo mainnet addresses used by Naira Reach.
// Sources: Textile FX address book (docs.textilecredit.com/protocol/address-book.html),
// Celo fee currencies (docs.celo.org/tooling/contracts/fee-currencies),
// ERC-8004 registry as shipped in @altananetwork/sdk.
import type { Address } from "viem";

export const CELO_CHAIN_ID = 42220;

export const TOKENS = {
  /** Tether USD (USD₮), 6 decimals. What the client pays in. */
  USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
  /** Compliant Naira (cNGN), 6 decimals. What the freelancer receives. */
  CNGN: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
} as const satisfies Record<string, Address>;

export const DECIMALS = { USDT: 6, CNGN: 6 } as const;

/** Textile FX LimitOrderReactor on Celo. The swap is sent here; USD₮ is approved to it. */
export const TEXTILE_REACTOR: Address = "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3";

/**
 * feeCurrency entry for USD₮ (an adapter, because USD₮ has 6 decimals).
 * Lets a one-time payout address pay its own gas in USD₮, since cNGN is not a Celo gas token.
 */
export const USDT_FEE_CURRENCY: Address = "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72";

/** ERC-8004 identity registry on Celo mainnet. */
export const ERC8004_IDENTITY_REGISTRY: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

export const TEXTILE_API_URL = "https://api.textilecredit.com/v2";
export const DEFAULT_RPC_URL = "https://forno.celo.org";
export const EXPLORER_TX = (hash: string) => `https://celoscan.io/tx/${hash}`;
