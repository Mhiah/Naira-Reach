import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Point all local state at a fresh temp folder for one test. */
export function freshState(): string {
  const dir = mkdtempSync(join(tmpdir(), "naira-reach-"));
  process.env.NAIRA_REACH_HOME = join(dir, "state");
  process.env.NAIRA_REACH_RECEIPTS = join(dir, "receipts");
  return dir;
}

export function writeFile(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** A fetch stand-in that answers from a handler and records requests. */
export function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init, body });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}
