#!/usr/bin/env node
// Naira Reach command line. Run with: npm run reach -- <command>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatUnits, getAddress, isAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { activateClientWallet, clientWalletAddress, grantAgentSession, hasAgentSession, loadAgentSession, refreshTakerProof, revokeAgentSession } from "./altana.ts";
import { DECIMALS, EXPLORER_TX, TOKENS } from "./celo.ts";
import { fmt, loadFreelancers, loadLedger, saveFreelancers, type Freelancer } from "./checks.ts";
import { claimPayout, createFreelancerKeys } from "./claim.ts";
import { attributionCode, ConfigError, privateKey, settings } from "./config.ts";
import { AltanaExecutor, DirectExecutor, publicClient, type Executor } from "./executor.ts";
import { anthropicExtractor } from "./invoice.ts";
import { payInvoice } from "./pay.ts";
import { parseMetaAddress } from "./stealth.ts";
import { verifyTag } from "./tag.ts";
import { TextileClient } from "./textile.ts";

const HELP = `Naira Reach — Paid from anywhere. Privately. Only to you.

Client (the one paying)
  wallet new-key               Make a fresh key for your Altana wallet and save it in .env (shown nowhere)
  wallet setup                 Create and activate your Altana wallet (also registers its ERC-8004 identity)
  session grant                Give the agent a limited key  [--usdt-per-week 200] [--cngn-per-week 300000] [--days 7]
  session revoke               Take the agent's key back, effective immediately
  proof refresh                Re-sign Textile's wallet proof (needed about every 11 hours, keyless only)
  freelancer add               Approve a freelancer  --id ada --name "Ada O." --meta st:celo:0x… [--max 500000] [--agreed 150000]
  freelancer list              Show approved freelancers and what has been paid

Agent
  pay <invoice>                Settle an invoice  [--dry-run] [--direct] [--approve-holds]

Freelancer (the one getting paid)
  freelancer keys              Make your private receiving code (share the st:celo:… line with clients)
  freelancer claim <receipt>   Move a payout to your wallet or exchange  --to 0x…

Anyone
  check                        What is set up and what is missing
  verify <txHash>              Is the attribution tag readable on this transaction?
`;

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const args = [sub, ...rest].filter((x): x is string => x !== undefined);
  switch (cmd) {
    case "check":
      return check();
    case "wallet":
      if (sub === "setup") return walletSetup();
      if (sub === "new-key") return walletNewKey();
      break;
    case "session":
      if (sub === "grant") return sessionGrant(rest);
      if (sub === "revoke") return sessionRevoke();
      break;
    case "proof":
      if (sub === "refresh") return proofRefresh();
      break;
    case "freelancer":
      if (sub === "add") return freelancerAdd(rest);
      if (sub === "list") return freelancerList();
      if (sub === "keys") return freelancerKeys();
      if (sub === "claim") return freelancerClaim(rest);
      break;
    case "pay":
      return pay(args);
    case "verify":
      return verify(args);
  }
  console.log(HELP);
}

// ---------- client ----------

/** Make the client's wallet key on this computer and write it straight into .env. */
function walletNewKey() {
  const envPath = ".env";
  if (!existsSync(envPath)) throw new ConfigError("No .env file here. Run this from the Naira-Reach folder.");
  const text = readFileSync(envPath, "utf8");
  const line = text.match(/^CLIENT_ADMIN_PRIVATE_KEY=(.*)$/m);
  if (line && line[1]!.trim()) throw new ConfigError("CLIENT_ADMIN_PRIVATE_KEY already has a key. Not replacing it.");
  const key = generatePrivateKey();
  const next = line ? text.replace(/^CLIENT_ADMIN_PRIVATE_KEY=.*$/m, `CLIENT_ADMIN_PRIVATE_KEY=${key}`) : `${text.trimEnd()}\nCLIENT_ADMIN_PRIVATE_KEY=${key}\n`;
  writeFileSync(envPath, next);
  console.log(`New wallet key saved in .env. Its address: ${privateKeyToAccount(key).address}`);
  console.log("Back up .env somewhere safe now (a password manager is best). If it is lost, so is the money in this wallet.");
}

async function walletSetup() {
  const key = privateKey("CLIENT_ADMIN_PRIVATE_KEY", "This is the client's own key for their Altana wallet. It never goes to the agent.");
  console.log("Activating your Altana wallet on Celo…");
  const { wallet, result } = await activateClientWallet(key);
  console.log(`Wallet: ${wallet}`);
  console.log(`Status: ${result.status}${result.transactionHash ? `  ${EXPLORER_TX(result.transactionHash)}` : ""}`);
  if (result.agentIdentity?.status === "registered") console.log(`ERC-8004 agent id: ${result.agentIdentity.agentId}`);
  else if (result.agentIdentity) console.log(`ERC-8004 identity: ${JSON.stringify(result.agentIdentity)}`);
}

async function sessionGrant(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { "usdt-per-week": { type: "string", default: "200" }, "cngn-per-week": { type: "string", default: "300000" }, days: { type: "string", default: "7" } },
  });
  const key = privateKey("CLIENT_ADMIN_PRIVATE_KEY", "The client signs the grant with their own key.");
  const limits = {
    usdtPerWeek: Number(values["usdt-per-week"]),
    cngnPerWeek: Number(values["cngn-per-week"]),
    days: Number(values.days),
    announcer: settings.announcer(),
  };
  console.log(`Granting the agent: up to ${limits.usdtPerWeek} USD₮ and ₦${fmt(limits.cngnPerWeek)} a week, for ${limits.days} days.`);
  console.log("It may only approve USD₮, swap on Textile FX, and send cNGN and gas money. Everything else is refused on-chain.");
  const session = await grantAgentSession(key, limits);
  console.log(`Granted. Expires ${new Date(session.expiry * 1000).toUTCString()}.`);
}

async function sessionRevoke() {
  const key = privateKey("CLIENT_ADMIN_PRIVATE_KEY", "The client revokes with their own key.");
  const r = await revokeAgentSession(key);
  console.log(`Revoked: ${JSON.stringify(r.status)}${r.transactionHash ? `  ${EXPLORER_TX(r.transactionHash)}` : ""}`);
}

async function proofRefresh() {
  const key = privateKey("CLIENT_ADMIN_PRIVATE_KEY", "The client signs the proof with their own key.");
  const p = await refreshTakerProof(key);
  console.log(`Signed. The agent can get Textile quotes until about ${new Date(p.issuedAt + 11 * 3600_000).toLocaleString()}.`);
}

function freelancerAdd(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      id: { type: "string" },
      name: { type: "string" },
      meta: { type: "string" },
      max: { type: "string" },
      agreed: { type: "string" },
      alias: { type: "string", multiple: true },
    },
  });
  if (!values.id || !values.name || !values.meta) throw new ConfigError("freelancer add needs --id, --name and --meta.");
  parseMetaAddress(values.meta);
  const entry: Freelancer = {
    id: values.id,
    name: values.name,
    metaAddress: values.meta,
    aliases: values.alias,
    maxInvoiceNgn: values.max ? Number(values.max) : undefined,
    agreedNgn: values.agreed ? Number(values.agreed) : undefined,
  };
  saveFreelancers([...loadFreelancers().filter((f) => f.id !== entry.id), entry]);
  console.log(`Approved ${entry.name} (${entry.id}). Payouts go to fresh private addresses from their code; invoice addresses are ignored.`);
}

function freelancerList() {
  const ledger = loadLedger();
  const list = loadFreelancers();
  if (!list.length) return console.log("No approved freelancers yet.");
  for (const f of list) {
    const paid = ledger.filter((p) => p.freelancerId === f.id);
    const total = paid.reduce((s, p) => s + p.amountNgn, 0);
    console.log(`${f.id}  ${f.name}  paid ${paid.length} invoice(s), ₦${fmt(total)}${f.maxInvoiceNgn ? `  limit ₦${fmt(f.maxInvoiceNgn)}` : ""}${f.agreedNgn ? `  agreed ₦${fmt(f.agreedNgn)}` : ""}`);
  }
}

// ---------- agent ----------

async function pay(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { "dry-run": { type: "boolean" }, direct: { type: "boolean" }, "approve-holds": { type: "boolean" } },
  });
  const invoicePath = positionals[0];
  if (!invoicePath) throw new ConfigError("Usage: pay <invoice.json|invoice.txt> [--dry-run]");
  const code = attributionCode();
  const rpcUrl = settings.rpcUrl();
  const dryRun = Boolean(values["dry-run"]);
  // A dry run needs no wallet: it prices with Textile's preview and sends nothing.
  const executor: Executor | undefined = values.direct
    ? new DirectExecutor(privateKey("DIRECT_WALLET_PRIVATE_KEY", "Needed only for --direct."), rpcUrl, code)
    : dryRun && !hasAgentSession()
      ? undefined
      : new AltanaExecutor(loadAgentSession(), code);
  const anthropicKey = settings.anthropicKey();

  const outcome = await payInvoice(invoicePath, {
    executor,
    textile: new TextileClient(settings.textileUrl(), settings.textileKey()),
    textileKeyless: !settings.textileKey(),
    reader: publicClient(rpcUrl),
    code,
    maxUsdt: settings.maxInvoiceUsdt(),
    gasTopUpUsdt: settings.gasTopUpUsdt(),
    announcer: settings.announcer(),
    extractor: anthropicKey ? anthropicExtractor(anthropicKey, settings.anthropicModel()) : undefined,
    approveHolds: values["approve-holds"],
    dryRun,
    log: (l) => console.log(l),
  });

  for (const n of outcome.notes) console.log(`Note: ${n}`);
  switch (outcome.status) {
    case "held":
      console.log("Held. Nothing was sent:");
      for (const h of outcome.holds) console.log(`  • ${h}`);
      console.log("If you have checked and want to pay anyway, run again with --approve-holds.");
      process.exitCode = 2;
      return;
    case "planned":
      console.log(`Dry run. Would pay ₦${fmt(outcome.preview.invoice.amountNgn)} to ${outcome.preview.freelancer.name} at a fresh private address ${outcome.preview.payout.stealthAddress}`);
      console.log(`About ${outcome.preview.usdtCost.toFixed(4)} USD₮ (₦${outcome.preview.ngnPerUsdt.toFixed(2)} per USD₮, indicative). Steps: ${outcome.preview.steps.join(" → ")}`);
      console.log("Nothing was reserved or sent. The real payment locks a firm quote first.");
      return;
    case "failed":
      console.log(`The transaction did not confirm. Hashes: ${outcome.hashes.join(", ") || "none"}`);
      process.exitCode = 1;
      return;
    case "paid":
      console.log(`Paid ₦${fmt(outcome.plan.invoice.amountNgn)} to ${outcome.plan.freelancer.name}, privately.`);
      for (const t of outcome.tags) console.log(`  ${EXPLORER_TX(t.hash)}  tag ${t.tagged ? "readable ✓" : "not readable on the outer transaction"}`);
      console.log(`Receipt: ${outcome.receiptPath}  (send it to the freelancer; it holds what they need to open the payout)`);
  }
}

// ---------- freelancer ----------

function freelancerKeys() {
  const keys = createFreelancerKeys();
  console.log("Your private receiving code (safe to share with clients):");
  console.log(keys.metaAddress);
  console.log("Your keys are saved on this device only. Back up .naira-reach/freelancer-keys.json; without it you cannot open payouts.");
}

async function freelancerClaim(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { to: { type: "string" } } });
  const receiptPath = positionals[0];
  if (!receiptPath || !values.to || !isAddress(values.to)) throw new ConfigError("Usage: freelancer claim <receipt.json> --to 0x…");
  const rpcUrl = settings.rpcUrl();
  const r = await claimPayout({
    receipt: JSON.parse(readFileSync(receiptPath, "utf8")),
    to: getAddress(values.to) as Address,
    reader: publicClient(rpcUrl),
    rpcUrl,
    code: attributionCode(),
  });
  console.log(`Moved ₦${fmt(Number(formatUnits(r.cngn, DECIMALS.CNGN)))} from ${r.from} to ${r.to}.  ${EXPLORER_TX(r.hash)}`);
}

// ---------- anyone ----------

async function verify(argv: string[]) {
  const hash = argv[0] as Hex | undefined;
  if (!hash) throw new ConfigError("Usage: verify <txHash>");
  const r = await verifyTag(publicClient(settings.rpcUrl()), hash, attributionCode());
  console.log(r.tagged ? `Tagged with ${r.codes.join(", ")} ✓` : `No ${attributionCode()} tag on this transaction's calldata. Codes found: ${r.codes.join(", ") || "none"}`);
}

function check() {
  const line = (ok: boolean, label: string, hint = "") => console.log(`${ok ? "✓" : "✗"} ${label}${!ok && hint ? `  — ${hint}` : ""}`);
  let code = "";
  try {
    code = attributionCode();
  } catch {}
  line(Boolean(code), `Attribution code${code ? `: ${code}` : ""}`, "set ATTRIBUTION_CODE (from Loops House enrollment)");
  console.log(`${settings.textileKey() ? "✓ Textile API key" : "• Textile: keyless (quotes are proven with a wallet signature)"}`);
  line(Boolean(process.env.CLIENT_ADMIN_PRIVATE_KEY), "Client wallet key (client device only)", "set CLIENT_ADMIN_PRIVATE_KEY to run wallet setup / session grant");
  const wallet = clientWalletAddress();
  line(Boolean(wallet), `Client Altana wallet${wallet ? `: ${wallet}` : ""}`, "run: wallet setup");
  let sessionLine = "Agent session";
  let sessionOk = false;
  if (hasAgentSession()) {
    try {
      const s = loadAgentSession();
      sessionOk = true;
      sessionLine += `: expires ${new Date(s.expiry * 1000).toUTCString()}`;
    } catch (e) {
      sessionLine += `: ${(e as Error).message}`;
    }
  }
  line(sessionOk, sessionLine, "run: session grant");
  line(loadFreelancers().length > 0, `Approved freelancers: ${loadFreelancers().length}`, "run: freelancer add");
  line(Boolean(settings.anthropicKey()), "AI invoice reader (optional)", "set ANTHROPIC_API_KEY to read plain-text invoices");
  console.log(`Tokens: USD₮ ${TOKENS.USDT}  cNGN ${TOKENS.CNGN}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof ConfigError ? e.message : `Error: ${(e as Error).message ?? String(e)}`);
  process.exitCode = 1;
});
