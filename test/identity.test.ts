// The agent's ERC-8004 profile: what the new registration file says, that the
// transaction carries it intact (with the tag), that only the identity's owner sends
// it, and that nothing is sent when the registry already holds it. The chain is a
// small fake JSON-RPC server, so the signed transaction can be taken apart.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, getAddress, keccak256, toHex, type Hex, type PublicClient } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { parseTransaction } from "viem/celo";
import { createAgent } from "../src/agent.ts";
import { ERC8004_IDENTITY_REGISTRY, USDT_FEE_CURRENCY } from "../src/celo.ts";
import { agentRegistration, IDENTITY_ABI, profileCalldata, registrationUri, SITE_URL, updateAgentProfile } from "../src/identity.ts";
import { store } from "../src/store.ts";
import { readTag } from "../src/tag.ts";
import type { TextileClient } from "../src/textile.ts";
import { freshState } from "./helpers.ts";

const KEY = ("0x" + "4c".repeat(32)) as Hex;
const WALLET = privateKeyToAddress(KEY);
const OTHER = "0x1234567890abcdef1234567890abcdef12345678";

const decodeUri = (uri: string) => JSON.parse(Buffer.from(uri.split(",")[1]!, "base64").toString("utf8"));

describe("the new profile", () => {
  it("is a registration-v1 file that points to Naira Reach, not Altana", () => {
    const r = agentRegistration("10090");
    expect(r.type).toBe("https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
    expect(r.name).toBe("Naira Reach");
    expect(r.image.startsWith(SITE_URL)).toBe(true);
    expect(r.services).toEqual([{ name: "web", endpoint: SITE_URL }]);
    expect(JSON.stringify(r)).not.toMatch(/altana-icon|explorer\.altana/);
    expect(r.active).toBe(true);
    expect(r.supportedTrust).toEqual(["reputation"]);
  });

  it("the site's .well-known file names Agent #10090 with the same profile", async () => {
    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync("web/.well-known/agent-registration.json", "utf8"))).toEqual(agentRegistration("10090"));
  });

  it("names its own entry in Celo's registry", () => {
    expect(agentRegistration(10090n).registrations).toEqual([{ agentId: 10090, agentRegistry: `eip155:42220:${ERC8004_IDENTITY_REGISTRY}` }]);
  });

  it("is stored as a data: URI that decodes back to the same file, ₮ included", () => {
    const uri = registrationUri("10090");
    expect(uri.startsWith("data:application/json;base64,")).toBe(true);
    expect(decodeUri(uri)).toEqual(agentRegistration("10090"));
    expect(decodeUri(uri).description).toContain("USD₮");
  });

  it("the transaction calls setAgentURI with that URI, and carries the tag", () => {
    const data = profileCalldata("10090", "celo_test");
    expect(readTag(data)).toEqual(["celo_test"]);
    const { functionName, args } = decodeFunctionData({ abi: IDENTITY_ABI, data });
    expect(functionName).toBe("setAgentURI");
    expect(args).toEqual([10090n, registrationUri("10090")]);
  });
});

// ---------- a fake Celo node ----------

let server: Server;
let rpcUrl = "";
let owner: string = WALLET;
let uriOnChain = "data:application/json;base64,e30=";
let sent: Hex[] = [];

beforeEach(async () => {
  freshState();
  sent = [];
  owner = WALLET;
  uriOnChain = "data:application/json;base64,e30=";
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const calls = JSON.parse(body);
      const one = (c: { id: number; method: string; params: { data?: Hex }[] }) => {
        const r = (result: unknown) => ({ jsonrpc: "2.0", id: c.id, result });
        switch (c.method) {
          case "eth_chainId": return r("0xa4ec");
          case "eth_getTransactionCount": return r("0x7");
          case "eth_gasPrice": return r(toHex(25n * 10n ** 9n));
          case "eth_maxPriorityFeePerGas": return r(toHex(10n ** 9n));
          case "eth_estimateGas": return r(toHex(900_000n));
          case "eth_getBlockByNumber": return r({ number: "0x10", baseFeePerGas: toHex(25n * 10n ** 9n), timestamp: "0x1", hash: "0x" + "ab".repeat(32), transactions: [] });
          case "eth_call": {
            const sel = c.params[0]!.data!.slice(0, 10);
            if (sel === "0x6352211e") return r(encodeAbiParameters([{ type: "address" }], [owner as Hex])); // ownerOf
            if (sel === "0xc87b56dd") return r(encodeAbiParameters([{ type: "string" }], [uriOnChain])); // tokenURI
            return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "unexpected call" } };
          }
          case "eth_sendRawTransaction": {
            const raw = (c.params as unknown as Hex[])[0]!;
            sent.push(raw);
            return r(keccak256(raw));
          }
          case "eth_getTransactionReceipt":
            return r({ status: "0x1", transactionHash: keccak256(sent[sent.length - 1]!), blockNumber: "0x10", blockHash: "0x" + "ab".repeat(32), logs: [], gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1", from: WALLET, to: ERC8004_IDENTITY_REGISTRY, transactionIndex: "0x0", logsBloom: "0x" + "0".repeat(512), type: "0x2", contractAddress: null });
          default: return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: c.method } };
        }
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(calls) ? calls.map(one) : one(calls)));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((ok) => server.close(() => ok())));

describe("sending the update", () => {
  it("sends one tagged setAgentURI to the registry from the wallet, gas paid in USD₮", async () => {
    const r = await updateAgentProfile({ adminKey: KEY, rpcUrl, agentId: "10090", code: "celo_test" });
    expect(r.status).toBe("updated");
    expect(sent).toHaveLength(1);
    const tx = parseTransaction(sent[0]!) as { to: Hex; data: Hex; feeCurrency?: Hex; value?: bigint };
    expect(getAddress(tx.to)).toBe(getAddress(ERC8004_IDENTITY_REGISTRY));
    expect(getAddress(tx.feeCurrency!)).toBe(getAddress(USDT_FEE_CURRENCY));
    expect(tx.value ?? 0n).toBe(0n);
    expect(readTag(tx.data)).toEqual(["celo_test"]);
    expect(decodeFunctionData({ abi: IDENTITY_ABI, data: tx.data }).args).toEqual([10090n, registrationUri("10090")]);
  });

  it("sends nothing when the registry already holds this profile", async () => {
    uriOnChain = registrationUri("10090");
    const r = await updateAgentProfile({ adminKey: KEY, rpcUrl, agentId: "10090" });
    expect(r.status).toBe("unchanged");
    expect(sent).toHaveLength(0);
  });

  it("refuses, before signing, an identity this wallet doesn't own", async () => {
    owner = OTHER;
    await expect(updateAgentProfile({ adminKey: KEY, rpcUrl, agentId: "10090" })).rejects.toThrow(/belongs to another wallet/);
    expect(sent).toHaveLength(0);
  });
});

describe("the website's profile request", () => {
  const agent = (opts: { hasKey?: boolean } = {}) => {
    const calls: string[] = [];
    const a = createAgent({
      textile: {} as TextileClient,
      textileKeyless: true,
      reader: { readContract: async () => 0n, getBalance: async () => 0n, getCode: async () => "0x" } as unknown as PublicClient,
      rpcUrl: "http://127.0.0.1:1",
      adminKey: () => KEY,
      hasAdminKey: () => opts.hasKey ?? true,
      attributionCode: () => "celo_test",
      maxInvoiceUsdt: 500,
      gasTopUpUsdt: 0.05,
      actions: {
        updateProfile: async (agentId) => {
          calls.push(agentId);
          return { status: "updated", hash: "0xabc" as Hex, agentId };
        },
      },
    });
    return { a, calls };
  };

  it("updates the wallet's own identity", async () => {
    store().write("client.json", { walletAddress: WALLET, activatedAt: "2026-11-21T00:00:00Z", agentId: "10090" });
    const { a, calls } = agent();
    await expect(a.dispatch("POST", "/wallet/profile", {})).resolves.toMatchObject({ status: "updated", agentId: "10090" });
    expect(calls).toEqual(["10090"]);
  });

  it("explains when the wallet has no identity yet", async () => {
    const { a, calls } = agent();
    await expect(a.dispatch("POST", "/wallet/profile", {})).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no ERC-8004 identity/) });
    expect(calls).toHaveLength(0);
  });

  it("needs the wallet key here: the agent's key alone can't change the profile", async () => {
    store().write("client.json", { agentId: "10090" });
    const { a, calls } = agent({ hasKey: false });
    await expect(a.dispatch("POST", "/wallet/profile", {})).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});
