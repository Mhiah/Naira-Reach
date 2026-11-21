# Naira Reach

**Paid from anywhere. Privately. Only to you.**

Naira Reach is an AI agent that settles a client's invoice to a Nigerian freelancer in naira. The client pays in USD₮, the freelancer receives the exact cNGN they billed, and the whole payment happens on Celo mainnet within limits the client sets and can revoke at any time.

Built for **Agents Open for Business** (Loops House, on Celo), entering the **Stablecoin Corridors** and **Altana Agent Wallets** tracks.

Demo video: coming soon

---

## What we built

A Nigerian freelancer paid from abroad loses at every step. Transfers take days. The rate shifts before the money lands. A fake invoice with swapped payment details can send the money to someone else. And once they start taking crypto, there is a new problem: a public wallet that shows every client they have and every naira they earn.

Naira Reach handles the whole payment, end to end. The client gives the agent a limited key to their own wallet. The agent reads the invoice, checks it, locks a quote for the exact naira amount, converts USD₮ to cNGN, and pays it to a fresh private address that only the freelancer can open.

### Three promises

| Promise | How it is kept |
|---|---|
| **In naira, exactly** | The agent asks Textile FX for an exact-output quote: "deliver exactly ₦150,000". The freelancer gets what they billed. The client sees the USD₮ cost before anything moves. |
| **Privately** | Every payout goes to a one-time address derived from the freelancer's private receiving code (ERC-5564 stealth addresses). Outsiders cannot link one payment to the next, or add up what a freelancer earns. Names, emails and bank details never go onchain. |
| **Only to you** | The agent never pays an address written on an invoice. It pays only the receiving code the client approved for that freelancer. A fake invoice has nothing to swap. |

### The client stays in control

The money never leaves the client's own Altana wallet until the moment of payment. The agent holds a **session key**, not the wallet. That key is limited on-chain:

- **What it may call:** approve USD₮, swap on the Textile FX reactor, transfer cNGN, and transfer a few cents of USD₮ as gas money. Any other call is refused by the wallet contract.
- **How much it may spend:** a weekly cap on USD₮ and a weekly cap on cNGN.
- **For how long:** the key expires on its own (7 days by default).
- **Revocable:** one command removes it, effective immediately.

All the steps for one invoice run as **one atomic intent**. Either the approval, swap, payout and gas money all happen, or none of them do. A failed swap can never leave half a payment behind.

### What it catches

Before any money moves, the agent runs these checks. A failed check is a **hold**: nothing is sent, and the client decides.

| Check | Example of what it stops |
|---|---|
| Is the freelancer on the approved list? | An invoice from someone the client never hired |
| Was this invoice number already paid? | The same invoice sent twice |
| Was this exact file already paid? | A renamed copy of an old invoice |
| Is the amount within this freelancer's limit? | A ₦2,000,000 invoice from someone who bills ₦150,000 |
| Does it match the agreed amount, if there is one? | A retainer quietly raised |
| Is the dollar cost within the client's ceiling? | A bad rate or a typo in the amount |
| Does the quote point at the real Textile reactor and pay the full amount? | A tampered or short quote |
| Does the invoice contain a wallet address? | Flagged and ignored, every time |

### What Naira Reach is made of

| Part | What it does |
|---|---|
| Invoice reader | Reads a JSON invoice directly, or a plain-text invoice with Claude. Contact and bank details are stripped before the text leaves the machine, and the model can only answer through a fixed form. |
| Checks and ledger | The approved freelancer list, the record of paid invoices, and the holds above. |
| Textile FX client | Requests a firm, exact-output USD₮ → cNGN quote and reports the fill. Works without an API key by proving control of the paying wallet. |
| Altana wallet and session | Sets up the client's wallet, grants and revokes the agent's limited key, and sends each payment as one atomic intent. |
| Private payouts | Makes the freelancer's receiving code, derives a fresh address per invoice, and lets the freelancer open it later. |
| Attribution | Adds the Loops House code to every transaction (ERC-8021) and checks it is readable onchain. |
| Receipts | One file per payment: amount, rate, transaction links, the invoice fingerprint, and what the freelancer needs to open the payout. No personal details. |

---

## How it fits the tracks

### Stablecoin Corridors (Textile FX)

| Requirement | How Naira Reach meets it |
|---|---|
| A tagged Textile FX conversion on Celo mainnet, in a listed corridor, used in the product flow | Every invoice is settled by a USD₮ → cNGN conversion through Textile FX, and the conversion is the payment itself |
| A local-stablecoin payment that reaches a recipient outside the team | The cNGN goes to the freelancer, a real person outside the team, at a brand-new address nobody funded beforehand |
| An ERC-8004 identity | The agent's wallet registers as "Naira Reach" in the ERC-8004 registry on its first action |
| A named user with a real job done | A real client paying a real freelancer for real work |

### Altana Agent Wallets

| Requirement | How Naira Reach meets it |
|---|---|
| The agent acts from a non-custodial Altana wallet | The client's own Altana wallet holds the funds; the client's key never reaches the agent |
| Under a person-granted session key | The client grants the key with `session grant` |
| With a spend cap, a contract allowlist and an expiry | Weekly USD₮ and cNGN caps, four allowed calls, and a 7-day expiry, all enforced onchain |
| Revocable | `session revoke`, effective immediately |

---

## Who it is for

- **Clients abroad** who already pay in stablecoins (Web3 teams, agencies, startups) and want invoices settled in naira without handling the conversion themselves.
- **Nigerian freelancers** (writers, designers, developers) who want to be paid in naira, exactly what they billed, without publishing their income to the world.

---

## How a payment flows

```
Freelancer, once:  freelancer keys        → shares st:celo:0x… with the client
Client, once:      wallet setup           → Altana wallet, ERC-8004 identity
                   session grant          → agent gets a capped, expiring key
                   freelancer add         → approves the freelancer's code

Agent, per invoice:  pay invoice.json
  1. read the invoice                (AI reader sees redacted text only)
  2. run the checks                  (hold and stop if anything is off)
  3. derive a fresh private address  (from the freelancer's code, never from the invoice)
  4. lock a Textile quote            (exact naira out, USD₮ cost shown)
  5. one atomic intent, every call tagged:
       approve USD₮ → swap USD₮→cNGN → send cNGN → send gas money
  6. report the fill to Textile, check the tags, write the receipt

Freelancer, any time:  freelancer claim receipt.json --to 0x…
  opens the one-time address and moves the naira, paying gas in the USD₮ that came with it
```

---

## Try it yourself

You need Node.js 22.18 or newer. Naira Reach runs on Node's built-in TypeScript support, so there is no build step and no extra programs to download.

### 1. Install

```bash
git clone https://github.com/Mhiah/Naira-Reach.git
cd Naira-Reach
npm install --omit=dev
cp .env.example .env
```

Fill in `.env`. At minimum: `ATTRIBUTION_CODE`. A Textile API key is optional: without one, the paying wallet signs a short proof that it is the one asking for the quote.

On Windows PowerShell, type `npm.cmd` where this README says `npm`, or run commands directly with `node src/cli.ts <command>`.

### 2. See what is set up

```bash
npm run reach -- check
```

Result: a checklist with ✓ for what is ready and ✗ with the next step for what is not.

### 3. Freelancer: make a receiving code

On the freelancer's own device:

```bash
npm run reach -- freelancer keys
```

Result: a line starting `st:celo:0x…`. That is safe to share. The keys behind it stay on the device in `.naira-reach/freelancer-keys.json`. Back that file up: without it, payouts cannot be opened.

### 4. Client: set up the wallet

On the client's device. First make the wallet's key. It is written straight into `.env` and never shown:

```bash
npm run reach -- wallet new-key
```

Back up `.env` somewhere safe, such as a password manager. Then create the wallet:

```bash
npm run reach -- wallet setup
```

Result: the Altana wallet address and its ERC-8004 agent id. Send USD₮ to that address. Altana's relay pays itself in USD₮ when it accepts it and in CELO otherwise, so keep a little CELO there too until the first payment shows which one it took.

### 5. Client: give the agent a limited key

```bash
npm run reach -- session grant --usdt-per-week 200 --cngn-per-week 300000 --days 7
```

Result: `Granted. Expires …`

The grant also signs Textile's wallet proof, so the agent can get quotes without an API key. That proof lasts about 11 hours. After that, the client runs `npm run reach -- proof refresh`.

### 6. Client: approve the freelancer

```bash
npm run reach -- freelancer add --id ada --name "Ada Obi" --meta st:celo:0x… --max 500000
```

### 7. Agent: pay an invoice

Try a dry run first. It reads and checks the invoice, gets an indicative price from Textile's preview, and picks a fresh payout address. It reserves nothing, sends nothing, and needs no wallet:

```bash
npm run reach -- pay examples/invoice.json --dry-run
```

Result: the approximate cost in USD₮, the fresh payout address, and the steps it would take (`approve → swap → payout → gas money`).

Then pay for real:

```bash
npm run reach -- pay examples/invoice.json
```

Result: the transaction link, whether the tag is readable, and a receipt in `receipts/`. Send the receipt to the freelancer.

To see the AI reader and the fraud flag together, try the plain-text invoice. It has a wallet address written on it, which the agent flags and ignores:

```bash
npm run reach -- pay examples/invoice.txt --dry-run
```

### 8. Freelancer: move the naira

```bash
npm run reach -- freelancer claim receipts/INV-2026-014-….json --to 0xYourWalletOrExchangeDeposit
```

### 9. Client: take the key back

```bash
npm run reach -- session revoke
```

---

## Results

| What | Status |
|---|---|
| Unit and flow tests (no network) | 30 passing: tags, private payouts, invoice privacy, every hold, keyless Textile proofs, the full pay flow with a mocked Textile and wallet |
| Typecheck | Clean |
| Live run on Celo mainnet | Not yet. This section will list the transaction links once the first real payment is made. |

Run the tests yourself:

```bash
npm test
```

---

## Privacy, in detail

| Who | What they can see |
|---|---|
| Anyone looking at the chain | That the client's wallet swapped USD₮ for cNGN and sent cNGN to a new address. Not who owns that address, and not that it belongs to the same person as last month's payout. |
| The client | Every payment they made, with receipts. |
| The freelancer | Every payout made to their code, which only their viewing key can find. |
| The AI invoice reader | The invoice text with emails, phone numbers, account numbers and wallet addresses removed. |
| An accountant or tax office | Whatever the freelancer chooses to show. The receipt's fingerprint proves which invoice a payment settled, without the invoice ever being published. |

Naira Reach keeps the freelancer's income private from the public. It does not hide anything from the exchange the freelancer cashes out with, and it is not meant to.

---

## Honest limits

- **Not yet run on mainnet.** Everything is tested without a network. The first live payments may surface details the mocks cannot.
- **Textile from an Altana wallet is untested.** Without an API key, Textile needs proof that the paying wallet asked for the quote. An Altana wallet is an EIP-7702 account whose address is the client's own key, so the client signs that proof, and Textile honours it for firm quotes for about 12 hours. Neither that proof nor the swap itself has been tried from an Altana wallet yet.
- **Tags through the Altana relay.** Every call inside the intent carries the attribution tag, but the relay submits the outer transaction, so the tag may not be readable on it. `pay` reports this for every transaction, and `verify <hash>` checks any one. If the relay hides it, `--direct` sends each step from a plain wallet with the tag on the outer transaction.
- **cNGN is not a Celo gas token.** That is why each payout carries a few cents of USD₮, so the freelancer can move the naira without buying CELO.
- **The receipt matters.** The freelancer needs the receipt to open a payout. An optional ERC-5564 announcer would let them find payouts from the chain alone, but there is no announcer deployed on Celo today.
- **Cashing out.** cNGN is listed on Nigerian exchanges such as Busha and Quidax. Check that the one you use accepts cNGN on Celo.
- **The agent's USD₮ transfer permission is broad.** It exists only to send gas money to the payout address, and the weekly cap limits it.

---

## What's next

- First live payments for a real client and freelancer, with links in Results
- An announcer contract on Celo, so freelancers can find payouts without receipts
- A simple page where a freelancer pastes a receipt and claims, with no terminal needed
- Recurring invoices: retainers paid on a schedule within the same session limits

---

## Reference

### Commands

| Command | Who runs it | What it does |
|---|---|---|
| `check` | Anyone | Shows what is set up and what is missing |
| `wallet new-key` | Client | Makes the wallet key and saves it in `.env` without showing it |
| `wallet setup` | Client | Creates and activates the Altana wallet; registers the ERC-8004 identity |
| `session grant [--usdt-per-week N] [--cngn-per-week N] [--days N]` | Client | Gives the agent a capped, expiring key |
| `session revoke` | Client | Removes the agent's key |
| `proof refresh` | Client | Re-signs Textile's wallet proof, needed about every 11 hours when there is no API key |
| `freelancer add --id --name --meta [--max] [--agreed] [--alias]` | Client | Approves a freelancer's receiving code |
| `freelancer list` | Client | Approved freelancers and totals paid |
| `pay <invoice> [--dry-run] [--direct] [--approve-holds]` | Agent | Settles an invoice. `--dry-run` prices it with Textile's preview and sends nothing |
| `freelancer keys` | Freelancer | Makes the private receiving code |
| `freelancer claim <receipt> --to 0x…` | Freelancer | Moves a payout onward |
| `verify <txHash>` | Anyone | Checks the attribution tag on a transaction |

### Settings

| Variable | Needed for | Notes |
|---|---|---|
| `ATTRIBUTION_CODE` | Everything that sends | The code from Loops House enrollment |
| `TEXTILE_API_KEY` | Optional | Textile partner key. Without it, quotes are proven with a wallet signature |
| `CLIENT_ADMIN_PRIVATE_KEY` | Client commands | Stays on the client's device |
| `ANTHROPIC_API_KEY` | Plain-text invoices | Optional |
| `MAX_INVOICE_USDT` | Paying | Per-invoice dollar ceiling, default 500 |
| `GAS_TOP_UP_USDT` | Paying | Gas money per payout, default 0.05 |
| `CELO_RPC_URL` | Everything | Defaults to the public Celo RPC |
| `STEALTH_ANNOUNCER_ADDRESS` | Optional | ERC-5564 announcer, if one is deployed |
| `DIRECT_WALLET_PRIVATE_KEY` | `--direct` only | Optional. Without it, `--direct` sends from the client's own wallet key, the same address as the Altana wallet |

### Invoice format

```json
{
  "invoiceId": "INV-2026-014",
  "freelancer": "ada",
  "amountNgn": 150000,
  "description": "Four long-form articles",
  "issuedAt": "2026-11-21"
}
```

`freelancer` matches the approved list by id, name or alias. Any other fields, including payment details, are ignored.

### Contracts and tokens (Celo mainnet, chain 42220)

| Name | Address |
|---|---|
| USD₮ | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` |
| cNGN | `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` |
| Textile FX LimitOrderReactor | `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3` |
| USD₮ fee currency (for gas) | `0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72` |
| ERC-8004 identity registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |

Sources: the Textile FX address book, Celo's fee currency list, and the Altana SDK.

### Files

| Path | What it holds |
|---|---|
| `src/pay.ts` | The payment flow, start to finish |
| `src/invoice.ts` | Invoice reading, redaction and fingerprints |
| `src/checks.ts` | Approved freelancers, the ledger and the holds |
| `src/textile.ts` | Textile FX RFQ client |
| `src/proof.ts` | Textile's keyless wallet proof |
| `src/altana.ts` | Client wallet and the agent's session key |
| `src/executor.ts` | Sending through Altana (atomic) or a plain wallet |
| `src/stealth.ts` | Private payout addresses (ERC-5564 scheme 1) |
| `src/claim.ts` | The freelancer's claim |
| `src/tag.ts` | ERC-8021 attribution tags |
| `src/cli.ts` | The command line |
| `test/` | Tests |

Local state lives in `.naira-reach/` and receipts in `receipts/`. Both are gitignored.

---

## Credits

Built by Mhiah for Agents Open for Business.

Built on Celo, Textile FX for the conversion, Altana for the agent wallet, cNGN by WrappedCBDC, ERC-5564 stealth addresses, ERC-8004 agent identity, and ERC-8021 attribution.

## License

MIT
