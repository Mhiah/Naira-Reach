// A locked box for the agent's records and keys, opened only with the owner's
// password. Used for the file that moves the agent from a laptop to the online
// site, and for what the online site keeps in the browser.
//
// The password is stretched with PBKDF2-SHA256 (600,000 rounds, random salt)
// into an AES-256-GCM key; GCM also catches any change to the file. Runs the
// same in Node and in browsers (Web Crypto).

export type Sealed = {
  kind: "naira-reach-vault";
  v: 1;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  data: string;
};

export const VAULT_ITERATIONS = 600_000;
export const MIN_PASSWORD = 10;

export class VaultError extends Error {}

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new VaultError("This browser can't lock files. Use a recent Chrome, Edge, Firefox or Safari.");
  return s;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** An unlocked vault: the derived key stays in memory; the password does not. */
export type VaultKey = { key: CryptoKey; salt: string; iterations: number };

export function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD) throw new VaultError(`Use a password of at least ${MIN_PASSWORD} characters.`);
}

export async function newVaultKey(password: string, iterations = VAULT_ITERATIONS): Promise<VaultKey> {
  checkPassword(password);
  const salt = b64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  return { key: await derive(password, salt, iterations), salt, iterations };
}

export async function seal(value: unknown, vk: VaultKey): Promise<Sealed> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const data = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, vk.key, plain as BufferSource));
  return {
    kind: "naira-reach-vault",
    v: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: vk.iterations, salt: vk.salt },
    cipher: { name: "AES-GCM", iv: b64(iv) },
    data: b64(data),
  };
}

/** Open with the password. Returns the contents and the key, so later saves need no password. */
export async function open<T>(sealed: unknown, password: string): Promise<{ value: T; vk: VaultKey }> {
  const s = asSealed(sealed);
  const vk = { key: await derive(password, s.kdf.salt, s.kdf.iterations), salt: s.kdf.salt, iterations: s.kdf.iterations };
  return { value: await openWith<T>(s, vk), vk };
}

/** Open with a key already derived (same salt). */
export async function openWith<T>(sealed: unknown, vk: VaultKey): Promise<T> {
  const s = asSealed(sealed);
  if (s.kdf.salt !== vk.salt) throw new VaultError("This box was locked with a different password.");
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: "AES-GCM", iv: unb64(s.cipher.iv) as BufferSource }, vk.key, unb64(s.data) as BufferSource);
  } catch {
    throw new VaultError("That password doesn't open it.");
  }
  return JSON.parse(dec.decode(plain)) as T;
}

export function asSealed(v: unknown): Sealed {
  const s = (typeof v === "string" ? safeParse(v) : v) as Partial<Sealed> | undefined;
  const ok =
    s &&
    s.kind === "naira-reach-vault" &&
    s.v === 1 &&
    s.kdf?.name === "PBKDF2" &&
    s.kdf.hash === "SHA-256" &&
    Number.isInteger(s.kdf.iterations) &&
    s.kdf.iterations >= 100_000 &&
    s.kdf.iterations <= 5_000_000 &&
    typeof s.kdf.salt === "string" &&
    s.cipher?.name === "AES-GCM" &&
    typeof s.cipher.iv === "string" &&
    typeof s.data === "string";
  if (!ok) throw new VaultError("That isn't a Naira Reach locked file.");
  return s as Sealed;
}

async function derive(password: string, salt: string, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", enc.encode(password) as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: unb64(salt) as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
