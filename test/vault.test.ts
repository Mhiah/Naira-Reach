import { describe, expect, it } from "vitest";
import { createVaultStore, VAULT_ITEM, type KV } from "../src/browser/vaultstore.ts";
import { asSealed, newVaultKey, open, seal } from "../src/vault.ts";

const FAST = 100_000; // fewer rounds than real use, so tests stay quick

function memoryKV() {
  const m = new Map<string, string>();
  const kv: KV = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
  return { kv, m };
}

describe("vault", () => {
  it("opens only with the right password and notices tampering", async () => {
    const vk = await newVaultKey("correct horse battery", FAST);
    const sealed = await seal({ secret: "0xabc", big: 5n }, vk);
    expect(JSON.stringify(sealed)).not.toContain("0xabc");
    const { value } = await open<{ secret: string; big: string }>(JSON.stringify(sealed), "correct horse battery");
    expect(value).toEqual({ secret: "0xabc", big: "5" });
    await expect(open(sealed, "wrong horse battery")).rejects.toThrow("doesn't open");
    const bytes = atob(sealed.data);
    const flipped = btoa(String.fromCharCode(bytes.charCodeAt(0) ^ 1) + bytes.slice(1));
    await expect(open({ ...sealed, data: flipped }, "correct horse battery")).rejects.toThrow("doesn't open");
  });

  it("refuses short passwords, other files and weak settings", async () => {
    await expect(newVaultKey("short")).rejects.toThrow("at least 10");
    expect(() => asSealed('{"hello":1}')).toThrow("isn't a Naira Reach");
    const sealed = await seal({}, await newVaultKey("correct horse battery", FAST));
    expect(() => asSealed({ ...sealed, kdf: { ...sealed.kdf, iterations: 10 } })).toThrow();
  });
});

describe("the online site's locked store", () => {
  it("keeps records locked in storage and reopens them with the password", async () => {
    const { kv, m } = memoryKV();
    const v = createVaultStore(kv, { iterations: FAST });
    expect(v.status()).toBe("none");
    await v.create("correct horse battery", { "admin.key": { privateKey: "0x" + "22".repeat(32) } });
    v.store.write("ledger.json", [{ invoiceId: "INV-1", amountNgn: 2000 }]);
    v.store.write("inbox/abc.json", { name: "invoice.json", data: "e30=" });
    await v.flush();
    const saved = m.get(VAULT_ITEM)!;
    expect(saved).not.toContain("2222");
    expect(saved).not.toContain("INV-1");

    await v.lock();
    expect(v.status()).toBe("locked");
    expect(() => v.store.read("ledger.json", [])).toThrow("locked");
    await expect(v.unlock("wrong horse battery")).rejects.toThrow("doesn't open");
    await v.unlock("correct horse battery");
    expect(v.store.read("ledger.json", [])).toEqual([{ invoiceId: "INV-1", amountNgn: 2000 }]);
    expect(v.store.exists("inbox/abc.json")).toBe(false); // uploads aren't kept
    expect(v.store.list("")).toEqual(["admin.key", "ledger.json"]);
  });

  it("brings in the laptop's locked file, and won't overwrite an agent already here", async () => {
    const vk = await newVaultKey("laptop password!", FAST);
    const file = JSON.stringify(await seal({ v: 1, records: { "admin.key": { privateKey: "0x" + "33".repeat(32) }, "freelancers.json": [{ id: "ada" }] } }, vk));
    const { kv } = memoryKV();
    const v = createVaultStore(kv, { iterations: FAST });
    await expect(v.importFile(file, "not the password")).rejects.toThrow("doesn't open");
    await v.importFile(file, "laptop password!");
    expect(v.store.read("freelancers.json", [])).toEqual([{ id: "ada" }]);
    await expect(v.importFile(file, "laptop password!")).rejects.toThrow("already holds");
    const backup = await v.backup();
    v.forget();
    expect(v.status()).toBe("none");
    const again = createVaultStore(memoryKV().kv, { iterations: FAST });
    await again.importFile(backup, "laptop password!");
    expect(again.store.read<{ privateKey: string } | null>("admin.key", null)?.privateKey).toBe("0x" + "33".repeat(32));
  });
});
