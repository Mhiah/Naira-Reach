// Records as JSON files on the client's computer: .naira-reach/<name>, and
// receipts in receipts/. Both folders can be moved with NAIRA_REACH_HOME and
// NAIRA_REACH_RECEIPTS; they are read on every call so tests can point elsewhere.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { InvoiceFile } from "./invoice.ts";
import { toJson, type Store } from "./store.ts";

/** An invoice file on this computer, ready for the agent to read. */
export const invoiceFromPath = (path: string): InvoiceFile => ({ name: path, bytes: new Uint8Array(readFileSync(path)) });

export const stateDir = () => process.env.NAIRA_REACH_HOME?.trim() || ".naira-reach";
export const receiptsDir = () => process.env.NAIRA_REACH_RECEIPTS?.trim() || "receipts";

/** The file behind a record name. Names never leave their folder. */
export function fileOf(name: string): string {
  const parts = name.split("/").filter(Boolean);
  if (!parts.length || parts.some((p) => p === ".." || p === "." || p.includes("\\"))) throw new Error(`Bad record name: ${name}`);
  return parts[0] === "receipts" ? join(receiptsDir(), ...parts.slice(1)) : join(stateDir(), ...parts);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

export const fileStore: Store = {
  read(name, fallback) {
    const f = fileOf(name);
    if (!existsSync(f)) return fallback;
    return JSON.parse(readFileSync(f, "utf8"));
  },
  write(name, value, secret = false) {
    const f = fileOf(name);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, toJson(value));
    if (secret) {
      try {
        chmodSync(f, 0o600);
      } catch {
        // Windows ignores POSIX modes; the folder is still gitignored.
      }
    }
  },
  exists: (name) => existsSync(fileOf(name)),
  remove(name) {
    rmSync(fileOf(name), { force: true });
  },
  list(prefix) {
    const inReceipts = prefix.startsWith("receipts");
    const root = inReceipts ? receiptsDir() : stateDir();
    return walk(root)
      .map((f) => (inReceipts ? "receipts/" : "") + relative(root, f).split(sep).join("/"))
      .filter((n) => n.startsWith(prefix));
  },
};
