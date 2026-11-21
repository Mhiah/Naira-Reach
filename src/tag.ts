// ERC-8021 attribution tags, so every transaction Naira Reach sends is credited
// to the code Loops House assigned at enrollment.
import { fromDataSuffix, toDataSuffix, verifyTx } from "@celo/attribution-tags";
import { concat, size, slice, type Hex, type PublicClient } from "viem";

const MARKER = "80218021802180218021802180218021";

/**
 * Append the attribution suffix to calldata. If the calldata already carries a
 * schema-0 suffix, merge the codes into one suffix instead of stacking a second
 * one (indexers read only the last suffix).
 */
export function tagCalldata(data: Hex | undefined, code: string): Hex {
  const base: Hex = data && data !== "0x" ? data : "0x";
  const existing = base !== "0x" ? fromDataSuffix(base) : null;
  if (!existing) return concat([base, toDataSuffix(code)]);
  if (existing.schemaId !== 0) {
    throw new Error("Calldata already carries a non-app attribution suffix; refusing to rewrite it.");
  }
  const codesLength = parseInt(slice(base, size(base) - 18, size(base) - 17).slice(2), 16);
  const stripped = slice(base, 0, size(base) - 18 - codesLength);
  const codes = existing.codes.includes(code) ? existing.codes : [...existing.codes, code];
  return concat([stripped, toDataSuffix(codes)]);
}

export function readTag(data: Hex): string[] | null {
  if (!data.toLowerCase().endsWith(MARKER)) return null;
  return fromDataSuffix(data)?.codes ?? null;
}

/** Read a mined transaction and report whether its outer calldata carries our code. */
export async function verifyTag(client: PublicClient, hash: Hex, code: string) {
  const decoded = await verifyTx({ client, hash });
  return {
    hash,
    codes: decoded?.codes ?? [],
    tagged: Boolean(decoded?.codes.includes(code)),
  };
}
