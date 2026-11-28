# Naira Reach: guide for judges

This page walks through what to check, in order, with what you should see at each step. The [README](README.md) has the full description.

<table>
<tr>
<td align="center" width="25%"><b>Live site</b><br><a href="https://nairareach.myacxt.site">nairareach.myacxt.site</a></td>
<td align="center" width="25%"><b>First freelancer paid</b><br><a href="https://celoscan.io/tx/0xbd7f1a0ab05489db11b6e5cc793e63461095b0a0844704f44d27fdc26d43f1a5">Nerom, 0xbd7f…f1a5</a></td>
<td align="center" width="25%"><b>ERC-8004</b><br><a href="https://8004scan.io/agents/celo/10090">Agent #10090</a></td>
<td align="center" width="25%"><b>Demo video</b><br><a href="https://x.com/myacxt/status/2126570746432389343">Watch on X (2:40)</a></td>
</tr>
</table>

## Contents

1. [Naira Reach in one minute](#naira-reach-in-one-minute)
2. [Check the onchain proof](#check-the-onchain-proof)
3. [Try the website](#try-the-website)
4. [Run the tests](#run-the-tests)
5. [The judging criteria](#the-judging-criteria)
6. [Track requirements](#track-requirements)
7. [Where to look in the code](#where-to-look-in-the-code)
8. [What is not done yet](#what-is-not-done-yet)

---

## Naira Reach in one minute

- **Who it's for:** a client abroad paying a Nigerian freelancer.
- **What the agent does:** reads the freelancer's invoice, checks it for fraud, gets a firm Textile FX quote for the **exact naira billed**, converts the client's USD₮ to cNGN, and pays it to a **brand-new private address** only the freelancer can open (ERC-5564).
- **Who holds the money:** the client, in their own **Altana wallet**. The agent only has a limited session key: weekly caps, a short list of allowed calls, an expiry, and the client can take it back.
- **How the freelancer gets it:** their Receive page finds the payout from Celo's announcements, using keys that never leave their browser, and moves it on, paying the network fee with the USD₮ that came with it.
- **Where it runs:** one website. The agent runs in the client's own browser, with keys locked by the client's password. Nothing runs on our server except a relay that passes price requests to Textile.

---

## Check the onchain proof

About five minutes, on public explorers. Nothing to install.

### 1. The payment

Open [0x5131…0aea on Celoscan](https://celoscan.io/tx/0x5131fd5b5d14012e6a97a86a6cb4608264a52eebc1f67bf1e47a7a814d410aea) and look at the token transfers. In **one transaction** you should see:

| Transfer | Amount | What it is |
|---|---|---|
| USD₮, client wallet → Textile's maker | 1.388546 | The swap |
| USD₮, Textile's fee | 0.000277 | Textile's 0.02% fee. With the swap, 1.388823 USD₮, the price the client approved |
| cNGN, Textile → client wallet → private address | 2,000 | Exactly the naira on the invoice |
| USD₮, client wallet → private address | 0.05 | Gas money, so the freelancer can move the naira without buying CELO |
| USD₮, client wallet → Altana | 0.008864 | Altana's relay fee |

The private address is [`0x2448…9828`](https://celoscan.io/address/0x244863ede6688da2a60d2f77fd4ed9ee75729828). Nothing on it links it to the freelancer, and it was never used before this payment. It still holds the 2,000 cNGN and 0.05 USD₮. The client wallet was left with 0 cNGN and 0 leftover allowance to Textile.

This is the **Altana atomic intent**: approve, swap, payout and gas money as one transaction, sent by Altana's relayer with the client's wallet acting inside it. If any step had failed, none would have happened.

This first payment was a ₦2,000 test from the team to the team's own receiving code. The first payment to a real freelancer, Nerom, followed on 26 November: [0xbd7f…f1a5](https://celoscan.io/tx/0xbd7f1a0ab05489db11b6e5cc793e63461095b0a0844704f44d27fdc26d43f1a5).

### 1b. The same payment, sent by the agent wallet itself

Altana's relayer sent the first payment, so Loops House didn't count it: it counts transactions **from the agent wallet** with the code **at the end**. Since then, the agent still signs each payment with its limited key, and the wallet sends that signed payment to Altana's Orchestrator itself, tagged.

- [TEST-003, 0xd540…7754](https://celoscan.io/tx/0xd54014be53c8034b73d4484f32096cb2b7870a8299c075836c99459dde4f7754): **From** is the client wallet `0xB244…4431`, **To** is Altana's Orchestrator, and the input data ends with `celo_d6a0b77183c8` followed by the ERC-8021 marker `8021…8021`. The token transfers are the same shape as above: 1.387294 USD₮ to Textile's maker, 2,000 cNGN and 0.05 USD₮ to a fresh private address, Altana's fee, and the network fee paid in USD₮.
- [Its announcement, 0xa390…f96a](https://celoscan.io/tx/0xa390411fe01da15bc0b388d9b8a70a22ebc817a71ed43ef259e6674fd2eff96a): sent the same way.
- Loops House's **Verify tag** panel for this entry now shows **"Tag seen on-chain"** and **"ERC-8004 identity registered"**.
- We reported the relayer problem and our workaround to Altana as a product review, logged as [altana-sdk #162](https://github.com/altananetwork/altana-sdk/issues/162).

### 2. The agent's identity and its key

- [Agent #10090 on 8004scan](https://8004scan.io/agents/celo/10090): "Naira Reach", registered by the wallet's first transaction.
- [The wallet on Altana's explorer](https://explorer.altana.network/account/0xB2441B175d620A3Fd5CDef28fA1c6957e6224431): the session key, its weekly caps (200 USD₮ and ₦300,000), its expiry (22 December 2026), and the calls it's allowed to make.
- [The wallet on Celoscan](https://celoscan.io/address/0xB2441B175d620A3Fd5CDef28fA1c6957e6224431): an EIP-7702 account, so the wallet's address is the client's own key address.

### 3. Automatic delivery

- [The announcer at `0x5564…5564`](https://celoscan.io/address/0x55649E01B5Df198D18D95b5cc5051630cfD45564). Celo had no ERC-5564 announcer, so Naira Reach deployed the standard one, with ScopeLift's exact code and salt, so it sits at the same address as on other chains.
- [The announcement for the ₦2,000](https://celoscan.io/tx/0x14b4850f552900f143b26ecc45e35721f5eeed7e1ab91ab3a50ca2633bed5fc9): an `Announcement` event naming the private address and a one-time public key. Only the freelancer's viewing key can tell that it's theirs.

---

## Try the website

Open [nairareach.myacxt.site](https://nairareach.myacxt.site). The switch at the top left picks **Send** (client) or **Receive** (freelancer). Each side has a **Guide** link at the bottom of the left bar with every step and a picture.

### Receive, with no money and no wallet

1. Click **Receive**, then **Receiving code**, then **Create my receiving code**. Your keys are made in your browser.
2. Look at your code (`st:celo:0x…`). That's what a freelancer gives a client instead of a wallet address.
3. Open **Payouts**. The page scans Celo's announcements with your keys. A new code has no payouts, so you'll see an empty list: what matters is that the check runs in your browser, with nothing sent to us. (Your browser's network tab shows calls to Celo's public RPC, and nothing sent to Naira Reach.)
4. **How to cash out** on Payouts shows how the naira reaches a bank account.

### Send, up to the point where money is needed

1. Click **Send**. Type a password (at least 10 characters) twice and press **Create my wallet**. A wallet is made and locked in your browser.
2. The Overview shows the set-up list. Steps 3 to 5 need real USD₮ and about 21 CELO, so you can stop here.
3. The **Guide** shows the rest with pictures from the real screens: activating, giving the agent a key, adding a freelancer, paying an invoice with every check shown, and the "Delivered" result.
4. When you're done, press **Lock Send**. On the unlock screen, open **Use a different agent**, tick the box and press **Remove it from this browser** to delete the test wallet.

---

## Run the tests

```bash
git clone https://github.com/Mhiah/Naira-Reach.git
cd Naira-Reach
npm install
npm test            # 200 tests in 15 files, no network needed
npm run typecheck   # clean
```

Node.js 22.18 or newer. A full list of what the tests cover is in the README, under [Tests](README.md#tests). The ones worth a look:

| File | What it proves |
|---|---|
| `test/money.test.ts` | Every call in a payment decoded byte by byte; 13 kinds of bad quote refused; a price above what the client approved sends nothing; exact kobo amounts |
| `test/receive.test.ts` | Private addresses match ScopeLift's ERC-5564 library, 300 out of 300 |
| `test/move.test.ts` | The freelancer's move transaction signed against a simulated Celo node, decoded and its signer recovered |
| `test/pay.test.ts` | Every hold in the checks, and the full payment flow with a mocked Textile and wallet |
| `test/announcer.test.ts` | Announcements, and the standard announcer address worked out from ScopeLift's deployment |

To see the agent check an invoice without a wallet, run a dry run. It asks Textile's live preview for a price and sends nothing:

```bash
cp .env.example .env    # then set ATTRIBUTION_CODE=celo_d6a0b77183c8 in .env (Naira Reach's public code)
npm run reach -- freelancer keys
npm run reach -- freelancer add --id ada --name "Ada Obi" --meta <the st:celo:0x… code from the line above> --max 500000
npm run reach -- pay examples/invoice.json --dry-run
```

---

## The judging criteria

### Execution

- A working product on Celo mainnet, not a mock: one live website, a real Altana wallet, a real session key, a real Textile swap, and a real private payout that the freelancer's page found by itself.
- Built so a mistake can't lose money: one atomic intent per invoice, a slippage guard the client sets, quotes checked before use, and no way to pay an address written on an invoice.
- 200 tests, a clean typecheck, and no known vulnerabilities in dependencies.

### Value proposition

- **For freelancers:** exactly the naira they billed, in seconds instead of days, without showing the world what they earn.
- **For clients:** pay in the stablecoin they already hold, through an agent that can't be tricked into paying the wrong person and can't spend more than they allow.
- It covers the whole payment, from invoice to the freelancer's bank: checks, conversion, payout, delivery and cash-out steps.

### Onchain traction

- Live now: the wallet, the ERC-8004 identity, the session key, the first payment and the announcer, all on Celo mainnet and linked above.
- First real freelancer paid: **Nerom** ([@neromtoobad](https://x.com/neromtoobad)), ₦2,000 on 26 November 2026, checked, swapped, paid and announced in one transaction sent by the agent wallet with the tag: [0xbd7f…f1a5](https://celoscan.io/tx/0xbd7f1a0ab05489db11b6e5cc793e63461095b0a0844704f44d27fdc26d43f1a5). He confirmed it on his Receive page. In his words: "I got paid in naira without sharing my bank details or wallet address. It showed up on my Receive page by itself."
- AskBots review from the Celo DevRel team (round 1): **9.2 / 10**, [issue #1](https://github.com/Mhiah/Naira-Reach/issues/1).

---

## Track requirements

### Stablecoin Corridors (Textile FX)

| Requirement | Status |
|---|---|
| Tagged Textile FX conversion on Celo mainnet, in a listed corridor, in the product flow | Done: USD₮ → cNGN, sent by the agent wallet with the tag last: [TEST-003](https://celoscan.io/tx/0xd54014be53c8034b73d4484f32096cb2b7870a8299c075836c99459dde4f7754). Loops House's check shows "Tag seen on-chain" |
| Local-stablecoin payment to a recipient outside the team | Done: ₦2,000 to Nerom, [0xbd7f…f1a5](https://celoscan.io/tx/0xbd7f1a0ab05489db11b6e5cc793e63461095b0a0844704f44d27fdc26d43f1a5) |
| ERC-8004 identity | Done: [Agent #10090](https://8004scan.io/agents/celo/10090) |
| A named user with a real job done | Done: Nerom ([@neromtoobad](https://x.com/neromtoobad)), paid for real work |

### Altana Agent Wallets

| Requirement | Status |
|---|---|
| Non-custodial Altana wallet | Done: the client's own wallet; the key stays locked in the client's browser |
| Person-granted session key | Done: given on **Agent access** |
| Spend cap, contract allowlist, expiry | Done: weekly USD₮ and cNGN caps, five allowed calls on the current key (USD₮ approve and transfer, the Textile swap, cNGN transfer, the payout announcer; the first key had four, without the announcer), up to 90 days, enforced onchain |
| Revocable | Done: **Revoke the agent's key**, effective from the next block |

---

## Where to look in the code

| Claim | Where |
|---|---|
| The checks and holds | `src/pay.ts` (`reviewInvoice`), `src/checks.ts` |
| Exact-output quote and the quote checks | `src/textile.ts` (`parseQuote`, `quoteExpired`), `src/pay.ts` (`assertQuote`) |
| The slippage guard | `src/pay.ts` (`approvedUsdt`), `web/app.js` (what the client approves) |
| The atomic intent and the session key's permissions | `src/altana.ts`, `src/executor.ts`, `src/pay.ts` (`buildCalls`) |
| Private addresses | `src/stealth.ts` |
| Announcements and automatic delivery | `src/announcer.ts`, `src/agent.ts` (`setupDelivery`), `src/browser/receive.ts` (`scan`) |
| The client's locked wallet in the browser | `src/vault.ts`, `src/browser/vaultstore.ts`, `src/browser/send.ts` |
| Invoice redaction before the AI reader | `src/invoice.ts` |
| The only server part | `web/api/textile.mjs`: an allowlisted relay to Textile, USD₮ → cNGN on Celo only |
| Attribution tags | `src/tag.ts` |
| The wallet sending its own signed payment, tagged | `src/selfsubmit.ts`, tested in `test/selfsubmit.test.ts` |

---

## What is not done yet

Said plainly, so nothing is a surprise:

- **One real freelancer so far.** Nerom is the first; more are welcome, and anyone can make a receiving code on the live site.
- **Payouts reach naira in a bank through an exchange.** The freelancer moves the cNGN to an exchange that takes cNGN on Celo, then withdraws; Naira Reach doesn't do the bank step itself.

The README's [Honest limits](README.md#honest-limits) has the full list.
