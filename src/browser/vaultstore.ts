// The online site's records: kept in memory while Send is unlocked, and saved
// locked (src/vault.ts) into the browser's storage after every action. Nothing
// is written unlocked. Uploaded invoices stay in memory only.
import { type Store, toJson } from "../store.ts";
import { newVaultKey, open, openWith, seal, VaultError, type VaultKey } from "../vault.ts";

export type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
export type Contents = { v: 1; records: Record<string, unknown> };

export const VAULT_ITEM = "nr.send.vault";
const UNSAVED = /^inbox\//;

export function createVaultStore(kv: KV, opts: { iterations?: number } = {}) {
  let records: Map<string, unknown> | null = null;
  let vk: VaultKey | null = null;
  let dirty = false;
  let chain: Promise<void> = Promise.resolve();

  const need = () => {
    if (!records) throw new VaultError("Send is locked. Unlock it first.");
    return records;
  };
  const copy = <T>(v: T): T => JSON.parse(toJson(v)) as T;

  const store: Store = {
    read<T>(name: string, fallback: T): T {
      const r = need();
      return r.has(name) ? copy(r.get(name) as T) : fallback;
    },
    write(name, value) {
      need().set(name, copy(value));
      dirty = true;
    },
    exists: (name) => need().has(name),
    remove(name) {
      if (need().delete(name)) dirty = true;
    },
    list: (prefix) => [...need().keys()].filter((n) => n.startsWith(prefix)).sort(),
  };

  async function save(): Promise<void> {
    if (!records || !vk) return;
    const keep = Object.fromEntries([...records].filter(([n]) => !UNSAVED.test(n)));
    const sealed = await seal({ v: 1, records: keep } satisfies Contents, vk);
    try {
      kv.setItem(VAULT_ITEM, JSON.stringify(sealed));
    } catch {
      throw new VaultError("This browser has no room left to save. Download your locked backup now.");
    }
    dirty = false;
  }

  function contentsOf(value: unknown): Record<string, unknown> {
    const c = value as Partial<Contents> | null;
    if (!c || c.v !== 1 || !c.records || typeof c.records !== "object") throw new VaultError("That file doesn't hold a Naira Reach agent.");
    return c.records;
  }

  return {
    store,
    status: (): "none" | "locked" | "unlocked" => (records ? "unlocked" : kv.getItem(VAULT_ITEM) ? "locked" : "none"),

    /** Start from nothing (a new wallet) or from records brought over in a locked file. */
    async create(password: string, initial: Record<string, unknown>): Promise<void> {
      if (kv.getItem(VAULT_ITEM)) throw new VaultError("This browser already holds an agent. Remove it first.");
      vk = await newVaultKey(password, opts.iterations);
      records = new Map(Object.entries(copy(initial)));
      await save();
    },

    async importFile(text: string, password: string): Promise<void> {
      if (kv.getItem(VAULT_ITEM)) throw new VaultError("This browser already holds an agent. Remove it first.");
      const opened = await open(text, password);
      const r = contentsOf(opened.value);
      if (!r["admin.key"]) throw new VaultError("That file has no wallet key in it.");
      vk = opened.vk;
      records = new Map(Object.entries(r));
      await save();
    },

    async unlock(password: string): Promise<void> {
      const text = kv.getItem(VAULT_ITEM);
      if (!text) throw new VaultError("There's no agent in this browser yet.");
      const opened = await open(text, password);
      records = new Map(Object.entries(contentsOf(opened.value)));
      vk = opened.vk;
      dirty = false;
    },

    /** Another tab saved: take its records, using the key we already hold. */
    async reload(text: string): Promise<void> {
      if (!vk) return;
      records = new Map(Object.entries(contentsOf(await openWith(text, vk))));
      dirty = false;
    },

    /** Save if anything changed. Saves run one after another. */
    flush(): Promise<void> {
      chain = chain.then(() => (dirty ? save() : undefined));
      return chain;
    },

    async lock(): Promise<void> {
      await this.flush().catch(() => {});
      records = null;
      vk = null;
    },

    /** The locked file as saved, for a backup. */
    async backup(): Promise<string> {
      await this.flush();
      const text = kv.getItem(VAULT_ITEM);
      if (!text) throw new VaultError("There's no agent in this browser yet.");
      return text;
    },

    forget(): void {
      kv.removeItem(VAULT_ITEM);
      records = null;
      vk = null;
    },
  };
}

export type VaultStore = ReturnType<typeof createVaultStore>;
