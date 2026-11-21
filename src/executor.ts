// Two ways to move the client's money:
//   altana: the agent acts through a session key on the client's Altana wallet.
//           Spend cap, contract allowlist and expiry are enforced on-chain, and all
//           calls for one invoice go in a single atomic intent.
//   direct: a plain wallet sends each call itself. Useful for testing and as a
//           fallback, since every transaction carries the tag in its own calldata.
import { createClient as createAltanaClient, CELO, NATIVE_TOKEN, type Session } from "@altananetwork/sdk";
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo } from "viem/chains";
import { TOKENS } from "./celo.ts";
import { tagCalldata } from "./tag.ts";

export type Call = { to: Address; data: Hex; value?: bigint; label: string };

export type SendResult = { hashes: Hex[]; status: "CONFIRMED" | "FAILED" | "PENDING" };

export interface Executor {
  readonly kind: "altana" | "direct";
  /** The wallet funds leave from. It is also the Textile taker. */
  readonly address: Address;
  send(calls: Call[]): Promise<SendResult>;
}

export function publicClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: celo, transport: http(rpcUrl) }) as PublicClient;
}

export class AltanaExecutor implements Executor {
  readonly kind = "altana" as const;
  readonly address: Address;
  private readonly client = createAltanaClient({ chains: [CELO] });
  private readonly session: Session;
  private readonly code: string;

  constructor(session: Session, code: string) {
    this.session = session;
    this.code = code;
    this.address = session.walletAddress;
  }

  async send(calls: Call[]): Promise<SendResult> {
    const result = await this.client.execute({
      session: this.session,
      calls: calls.map((c) => ({ to: c.to, data: tagCalldata(c.data, this.code), value: c.value ?? 0n })),
      // Relay fee in USD₮ if the relay accepts it, else CELO; either way inside the session's caps.
      feeToken: [TOKENS.USDT, NATIVE_TOKEN],
    });
    return { hashes: result.transactionHash ? [result.transactionHash] : [], status: result.status };
  }
}

export class DirectExecutor implements Executor {
  readonly kind = "direct" as const;
  readonly address: Address;
  private readonly wallet;
  private readonly reader: PublicClient;
  private readonly code: string;

  constructor(privateKey: Hex, rpcUrl: string, code: string) {
    this.code = code;
    const account = privateKeyToAccount(privateKey);
    this.address = account.address;
    this.wallet = createWalletClient({ account, chain: celo, transport: http(rpcUrl) });
    this.reader = publicClient(rpcUrl);
  }

  async send(calls: Call[]): Promise<SendResult> {
    const hashes: Hex[] = [];
    for (const c of calls) {
      const hash = await this.wallet.sendTransaction({ to: c.to, data: tagCalldata(c.data, this.code), value: c.value ?? 0n });
      hashes.push(hash);
      const receipt = await this.reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== "success") return { hashes, status: "FAILED" };
    }
    return { hashes, status: "CONFIRMED" };
  }
}
