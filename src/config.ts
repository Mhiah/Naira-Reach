import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { isHex, type Hex } from "viem";
import { DEFAULT_RPC_URL, TEXTILE_API_URL } from "./celo.ts";

/** Where Naira Reach keeps its local state (gitignored). Read lazily so tests can point it elsewhere. */
export const stateDir = () => process.env.NAIRA_REACH_HOME?.trim() || ".naira-reach";
export const receiptsDir = () => process.env.NAIRA_REACH_RECEIPTS?.trim() || "receipts";

const CODE_RE = /^[a-z0-9_]{1,32}$/;

export class ConfigError extends Error {}

function opt(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function need(name: string, why: string): string {
  const v = opt(name);
  if (!v) throw new ConfigError(`${name} is not set. ${why}`);
  return v;
}

export function privateKey(name: string, why: string): Hex {
  let raw = need(name, why);
  if (!raw.startsWith("0x")) raw = `0x${raw}`;
  if (!isHex(raw) || raw.length !== 66) throw new ConfigError(`${name} must be a 32-byte hex private key.`);
  return raw as Hex;
}

export function attributionCode(): string {
  const code = need("ATTRIBUTION_CODE", "Use the code Loops House gave you at enrollment (celo_...).");
  if (!CODE_RE.test(code)) throw new ConfigError("ATTRIBUTION_CODE must be 1-32 characters of a-z, 0-9 or _.");
  return code;
}

export const settings = {
  /** First name to greet the client with on the website. Optional. */
  clientName: () => opt("CLIENT_NAME"),
  rpcUrl: () => opt("CELO_RPC_URL") ?? DEFAULT_RPC_URL,
  textileUrl: () => opt("TEXTILE_API_URL") ?? TEXTILE_API_URL,
  textileKey: () => opt("TEXTILE_API_KEY"),
  anthropicKey: () => opt("ANTHROPIC_API_KEY"),
  anthropicModel: () => opt("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5",
  /** Most a single invoice may cost the client, in whole USD₮. A hard stop before anything is sent. */
  maxInvoiceUsdt: () => Number(opt("MAX_INVOICE_USDT") ?? "500"),
  /** USD₮ (in whole units) sent with each private payout so the freelancer can pay gas. */
  gasTopUpUsdt: () => Number(opt("GAS_TOP_UP_USDT") ?? "0.05"),
  /** Optional ERC-5564 announcer contract on Celo. Without it, the one-time key travels in the receipt only. */
  announcer: () => opt("STEALTH_ANNOUNCER_ADDRESS") as Hex | undefined,
};

// ---------- small JSON state helpers ----------

export function statePath(file: string): string {
  return join(stateDir(), file);
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown, secret = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  if (secret) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows ignores POSIX modes; the file is still gitignored.
    }
  }
}
