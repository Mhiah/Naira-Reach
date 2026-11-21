// Where Naira Reach keeps its records. The agent's code only ever names a record
// ("ledger.json", "receipts/INV-1-123.json"); the store decides where it lives.
//  - On the client's computer: JSON files in .naira-reach/ and receipts/ (src/filestore.ts).
//  - In the browser: the browser's own storage (src/browser/send.ts).
export interface Store {
  read<T>(name: string, fallback: T): T;
  /** `secret` marks keys: files get owner-only permissions, browsers keep them in the locked vault. */
  write(name: string, value: unknown, secret?: boolean): void;
  exists(name: string): boolean;
  remove(name: string): void;
  /** Every record whose name starts with `prefix`. */
  list(prefix: string): string[];
}

let active: Store | undefined;

export function useStore(s: Store): void {
  active = s;
}

export function store(): Store {
  if (!active) throw new Error("No store set up. The command line and the website set one up when they start.");
  return active;
}

/** JSON with bigints written as strings, the way every record is saved. */
export const toJson = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";

/** Records move rather than vanish: a revoked key is kept under revoked/. */
export function moveRecord(from: string, to: string, secret = false): void {
  const s = store();
  if (!s.exists(from)) return;
  s.write(to, s.read<unknown>(from, null), secret);
  s.remove(from);
}

/** A receipt's record name from what the ledger holds (old entries hold a file path). */
export const receiptName = (pathOrName: string) => `receipts/${pathOrName.split(/[\\/]/).pop()}`;
