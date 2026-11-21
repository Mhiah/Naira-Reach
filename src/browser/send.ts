// The Send side on the online site: the same agent as on the laptop
// (src/agent.ts), running in the client's own browser. The wallet key and the
// agent's key are kept here, locked with the client's password; the site's
// server never sees them. Textile is reached through the site's small proxy
// (web/api/textile.mjs) because Textile's API doesn't answer browsers directly.
// Bundled into web/vendor/send.js by `npm run build:web`.
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { celo } from "viem/chains";
import { AgentError, createAgent, type Json } from "../agent.ts";
import { TEXTILE_API_URL } from "../celo.ts";
import { useStore } from "../store.ts";
import { TextileClient } from "../textile.ts";
import { VaultError } from "../vault.ts";
import { createVaultStore, VAULT_ITEM, type KV } from "./vaultstore.ts";

type Config = { rpcUrl?: string; attributionCode?: string | null; textileProxy?: string };

const cfg: Config = (globalThis as unknown as { NR_CONFIG?: Config }).NR_CONFIG ?? {};
const rpcUrl = cfg.rpcUrl || "https://forno.celo.org";
const proxy = cfg.textileProxy || "/api/textile";

const kv: KV = globalThis.localStorage;
const vault = createVaultStore(kv);
useStore(vault.store);

/** Textile calls go to the site's proxy: /api/textile?p=rfq/preview and so on. */
const viaProxy: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(TEXTILE_API_URL + "/")) return Promise.reject(new Error("Only Textile goes through the proxy."));
  return fetch(`${proxy}?p=${encodeURIComponent(url.slice(TEXTILE_API_URL.length + 1))}`, init);
};

const agent = createAgent({
  textile: new TextileClient(TEXTILE_API_URL, undefined, viaProxy),
  textileKeyless: true,
  reader: createPublicClient({ chain: celo, transport: http(rpcUrl) }) as PublicClient,
  adminKey: () => {
    const k = vault.store.read<{ privateKey?: Hex } | null>("admin.key", null);
    if (!k?.privateKey) throw new AgentError(400, "There's no wallet key in this browser.");
    return k.privateKey;
  },
  hasAdminKey: () => vault.status() === "unlocked" && vault.store.exists("admin.key"),
  attributionCode: () => cfg.attributionCode ?? null,
  clientName: () => (vault.status() === "unlocked" ? (vault.store.read<{ clientName?: string }>("profile.json", {}).clientName ?? null) : null),
  maxInvoiceUsdt: 500,
  gasTopUpUsdt: 0.05,
});

const plain = (e: unknown) => new Error((e as Error)?.message || String(e));

// Another tab saved: pick up its records so the two don't overwrite each other.
globalThis.addEventListener?.("storage", (e: StorageEvent) => {
  if (e.key !== VAULT_ITEM || vault.status() !== "unlocked") return;
  if (!e.newValue) return void vault.lock();
  vault.reload(e.newValue).catch(() => vault.lock());
});

(globalThis as unknown as { NRSend: unknown }).NRSend = {
  status: () => vault.status(),

  /** A new wallet key, made in this browser. */
  async create(password: string, clientName?: string) {
    const name = String(clientName ?? "").trim().slice(0, 40);
    await vault.create(password, { "admin.key": { privateKey: generatePrivateKey() }, ...(name ? { "profile.json": { clientName: name } } : {}) }).catch((e) => {
      throw plain(e);
    });
  },

  /** The locked file from the laptop's Agent access page, or a backup from this site. */
  async importFile(text: string, password: string) {
    await vault.importFile(text, password).catch((e) => {
      throw plain(e);
    });
  },

  async unlock(password: string) {
    await vault.unlock(password).catch((e) => {
      throw plain(e);
    });
  },

  lock: () => vault.lock(),
  backup: () => vault.backup(),
  forget: () => vault.forget(),

  /** The same requests the laptop's server answers, e.g. ("POST", "/invoices", {...}). */
  async dispatch(method: string, path: string, body?: Record<string, unknown>): Promise<Json> {
    if (vault.status() !== "unlocked") throw new Error("Send is locked. Unlock it first.");
    try {
      return await agent.dispatch(method, path, body ?? {});
    } catch (e) {
      throw plain(e);
    } finally {
      // Whatever happened (a payment, a hold), it is saved before the page hears back.
      await vault.flush().catch((e: VaultError) => console.error(e.message));
    }
  },
};
