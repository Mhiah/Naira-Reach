// Naira Reach web app: one site, two sides. Plain JavaScript, no build step.
(function () {
  "use strict";
  const D = window.NR_SAMPLE;
  const view = document.getElementById("view");
  const menu = document.getElementById("menu");
  const sideCard = document.getElementById("side-card");

  // ---------- helpers ----------
  const ngn = (n) => "₦" + Number(n).toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const usdt = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const short = (a) => (a.length > 14 ? a.slice(0, 6) + "…" + a.slice(-4) : a);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmtDate = (iso) => new Date(iso + (iso.length === 10 ? "T12:00:00Z" : "")).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const today = () => new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };
  const pct = (a, b) => Math.max(0, Math.min(100, (a / b) * 100)).toFixed(1);

  const I = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    invoice: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .7 3.2 2.5 3.5 5.2"/>',
    key: '<circle cx="8" cy="14" r="4.5"/><path d="m11.5 11 8.5-8.5M17 5.5l2.5 2.5M14.5 8l2 2"/>',
    code: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h3M7 14h6M15 10h2"/>',
    inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    flag: '<path d="M12 6v8M12 18v.5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
    send: '<path d="M4 12h15M13 6l6 6-6 6"/>',
    shield: '<path d="M12 3 4.5 6v6c0 4.4 3.2 7.9 7.5 9 4.3-1.1 7.5-4.6 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name]}</svg>`;
  const badge = (text, kind = "") => `<span class="badge ${kind}"><span class="dot"></span>${esc(text)}</span>`;

  const MENUS = {
    pay: [
      ["overview", "Overview", "home"],
      ["invoice", "Pay an invoice", "invoice"],
      ["freelancers", "Freelancers", "people"],
      ["access", "Agent access", "key"],
    ],
    get: [
      ["code", "Receiving code", "code"],
      ["payouts", "Payouts", "inbox"],
    ],
  };

  function head({ title, lede, actions = "" }) {
    return `<header class="page-head">
      <div><time class="date">${today()}</time><h1>${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ""}</div>
      ${actions ? `<div class="actions">${actions}</div>` : ""}
    </header>`;
  }

  // ---------- I'm paying ----------
  function overview() {
    const s = D.session;
    const thisWeek = D.payouts.filter((p) => p.status === "Paid" && p.date >= "2026-11-16");
    const weekNgn = thisWeek.reduce((a, p) => a + p.ngn, 0);
    const leftUsdt = s.usdtPerWeek - s.usdtUsed;
    return `${head({
      title: `${greeting()}, ${esc(D.client.name)}`,
      lede: "Your agent settles invoices in naira from your own wallet, within the limits you set.",
      actions: `<a class="btn btn-secondary" href="#/pay/access">${icon("key")}Agent access</a><a class="btn btn-primary" href="#/pay/invoice">${icon("invoice")}Pay an invoice</a>`,
    })}
    <section class="grid-3" aria-label="Summary">
      <article class="card stat">
        <span class="label">Wallet balance</span>
        <span class="figure">${usdt(D.client.balanceUsdt)}<span class="unit">USD₮</span></span>
        <span class="note"><span class="mono">${short(D.client.wallet)}</span>${badge("Altana wallet", "neutral")}</span>
      </article>
      <article class="card stat">
        <span class="label">Paid out this week</span>
        <span class="figure">${ngn(weekNgn)}</span>
        <span class="note">${badge(thisWeek.length + " payouts")}to ${new Set(thisWeek.map((p) => p.who)).size} freelancers</span>
      </article>
      <article class="card stat">
        <span class="label">Agent limit left this week</span>
        <span class="figure">${usdt(leftUsdt)}<span class="unit">of ${s.usdtPerWeek} USD₮</span></span>
        <div class="bar" role="img" aria-label="${pct(s.usdtUsed, s.usdtPerWeek)}% used"><span style="width:${pct(s.usdtUsed, s.usdtPerWeek)}%"></span></div>
      </article>
    </section>
    <section class="grid-2" aria-label="Activity">
      <article class="card chart">
        <div class="card-head"><h2>Naira delivered</h2><div class="legend"><span><i></i>Naira paid</span><span><i class="dash"></i>Weekly limit</span></div></div>
        ${lineChart(D.weekly)}
      </article>
      <article class="card">
        <div class="card-head"><h2>Today's rate</h2><span class="small muted">Textile FX</span></div>
        <div class="stat"><span class="figure">${ngn(D.client.rate)}</span><span class="note">for 1 USD₮ · fee ${usdt(D.client.rateFee)} USD₮ per 100</span></div>
        <hr class="divider">
        <h3 class="small muted" style="font-family:var(--font-body);font-weight:400;letter-spacing:0;margin-bottom:var(--s3)">Paid to each freelancer</h3>
        <ul class="list">${D.freelancers.map((f) => `<li><div class="meta"><span class="strong">${esc(f.name)}</span><span class="small muted">${f.paid} ${f.paid === 1 ? "invoice" : "invoices"}</span></div><span class="amount">${ngn(f.total)}</span></li>`).join("")}</ul>
      </article>
    </section>
    <section class="card" aria-label="Recent payouts">
      <div class="card-head"><h2>Recent payouts</h2><a class="small" href="#/pay/freelancers">All freelancers</a></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Freelancer</th><th class="hide-sm">Date</th><th class="hide-sm">Status</th><th class="hide-sm">Transaction</th><th class="amount">Amount</th></tr></thead>
        <tbody>${D.payouts.map((p) => `<tr>
          <td><span class="strong">${esc(p.who)}</span><span class="sub mono">${esc(p.invoice)}${p.reason ? " · " + esc(p.reason) : ""}</span></td>
          <td class="hide-sm"><time>${fmtDate(p.date)}</time></td>
          <td class="hide-sm">${p.status === "Paid" ? badge("Paid") : badge("Held", "neutral")}</td>
          <td class="hide-sm mono small">${p.tx ? `<a href="#" aria-label="View transaction ${esc(p.tx)} on Celoscan">${esc(p.tx)}</a>` : '<span class="muted">Nothing sent</span>'}</td>
          <td class="amount">${ngn(p.ngn)}${p.usdt ? `<span class="sub">${usdt(p.usdt)} USD₮</span>` : ""}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </section>`;
  }

  function lineChart(w) {
    // Naira paid each week, against the agent's weekly limit (in naira at today's rate).
    const W = 640, H = 220, P = { l: 4, r: 4, t: 12, b: 4 };
    const limitNgn = D.session.usdtPerWeek * D.client.rate;
    const max = Math.max(...w.ngn, limitNgn) * 1.1;
    const x = (i) => P.l + (i * (W - P.l - P.r)) / (w.labels.length - 1);
    const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
    const pts = w.ngn.map(y);
    const line = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${v.toFixed(1)}`).join(" ");
    const area = `${line} L${x(w.labels.length - 1)},${H - P.b} L${x(0)},${H - P.b} Z`;
    const ly = y(limitNgn).toFixed(1);
    const grid = [0.25, 0.5, 0.75].map((f) => { const gy = (P.t + f * (H - P.t - P.b)).toFixed(1); return `<line x1="${P.l}" x2="${W - P.r}" y1="${gy}" y2="${gy}" stroke="var(--color-border)" stroke-width="1" vector-effect="non-scaling-stroke"/>`; }).join("");
    return `<div class="plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Naira paid per week over the last seven weeks, ${ngn(w.ngn[w.ngn.length - 1])} this week, against a weekly limit of about ${ngn(Math.round(limitNgn))}">
      ${grid}
      <path d="${area}" fill="color-mix(in srgb, var(--color-primary) 7%, transparent)"/>
      <line x1="${P.l}" x2="${W - P.r}" y1="${ly}" y2="${ly}" stroke="var(--color-secondary)" stroke-width="2" stroke-dasharray="6 6" vector-effect="non-scaling-stroke"/>
      <path d="${line}" fill="none" stroke="var(--color-primary)" stroke-width="2.25" vector-effect="non-scaling-stroke"/>
    </svg><div class="ticks" aria-hidden="true">${w.labels.map((l) => `<span>${l}</span>`).join("")}</div></div>`;
  }

  function payInvoice() {
    const v = D.invoice;
    const passed = v.checks.filter((c) => c.ok).length;
    return `${head({
      title: "Pay an invoice",
      lede: "The agent reads the invoice, checks it, and locks a quote for the exact naira billed. Nothing moves until you approve.",
    })}
    <section class="grid-2-even" aria-label="Invoice and checks">
      <div class="stack">
        <article class="card">
          <div class="card-head"><h2>Invoice</h2><span class="small muted">.json or .txt</span></div>
          <div class="drop">
            ${icon("upload")}
            <p class="strong">Drop an invoice here</p>
            <p class="small muted">Contact and bank details are removed before the AI reads it.</p>
            <button class="btn btn-secondary btn-sm" type="button">Choose a file</button>
          </div>
        </article>
        <article class="card">
          <div class="card-head"><h3>${esc(v.file)}</h3>${badge("Read by AI")}</div>
          <dl class="kv">
            <dt>From</dt><dd style="font-family:var(--font-body)">${esc(v.from)}</dd>
            <dt>Invoice</dt><dd>${esc(v.invoiceId)}</dd>
            <dt>Work</dt><dd style="font-family:var(--font-body)">${esc(v.description)}</dd>
            <dt>Amount billed</dt><dd class="total">${ngn(v.amountNgn)}</dd>
          </dl>
        </article>
      </div>
      <div class="stack">
        <article class="card">
          <div class="card-head"><h2>Checks</h2><span class="small muted">${passed} of ${v.checks.length} passed</span></div>
          <ul class="checks">${v.checks.map((c) => `<li>
            <span class="ico ${c.ok ? "" : "flag"}">${icon(c.ok ? "check" : "flag")}</span>
            <div><div class="strong">${esc(c.title)}</div><div class="small muted">${c.note}</div></div>
            ${c.ok ? "" : badge("Ignored")}
          </li>`).join("")}</ul>
        </article>
        <article class="card">
          <div class="card-head"><h2>Quote</h2><span class="badge"><span class="dot"></span>Locked · <span class="mono">${v.quote.expiresIn}s</span></span></div>
          <dl class="kv">
            <dt>Ada receives</dt><dd>${ngn(v.amountNgn)}</dd>
            <dt>Rate</dt><dd>${ngn(v.quote.rate)} / USD₮</dd>
            <dt>Textile fee</dt><dd>${usdt(v.quote.fee)} USD₮</dd>
            <dt>Private payout address</dt><dd>${esc(v.payoutAddress)}</dd>
          </dl>
          <hr class="divider">
          <div class="spread"><span class="strong">You pay</span><span class="mono total" style="font-size:var(--fs-section);font-weight:700">${usdt(v.quote.usdt)} USD₮</span></div>
          <div class="row" style="margin-top:var(--s5)">
            <button class="btn btn-secondary" type="button">Cancel</button>
            <button class="btn btn-primary" type="button" style="flex:1">${icon("send")}Approve and pay</button>
          </div>
          <p class="small muted" style="margin-top:var(--s3)">Approve, swap, payout and gas money go through as one transaction: all of it or none of it.</p>
        </article>
      </div>
    </section>`;
  }

  function freelancers() {
    return `${head({
      title: "Freelancers",
      lede: "The agent only pays people on this list, and only to the private code they shared with you. Addresses written on invoices are ignored.",
      actions: `<button class="btn btn-primary" type="button">${icon("plus")}Add a freelancer</button>`,
    })}
    <section class="card" aria-label="Approved freelancers">
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th class="hide-sm">Receiving code</th><th class="hide-sm amount">Limit per invoice</th><th class="hide-sm amount">Invoices paid</th><th class="amount">Total paid</th></tr></thead>
        <tbody>${D.freelancers.map((f) => `<tr>
          <td><span class="strong">${esc(f.name)}</span><span class="sub">${esc(f.role)}</span></td>
          <td class="hide-sm mono small">${esc(f.meta)}</td>
          <td class="hide-sm amount">${ngn(f.limit)}</td>
          <td class="hide-sm amount">${f.paid}</td>
          <td class="amount">${ngn(f.total)}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </section>
    <section class="card" aria-label="Add a freelancer">
      <div class="card-head"><h2>Add a freelancer</h2></div>
      <form class="grid-3" onsubmit="return false">
        <div class="field"><label for="f-name">Name</label><input class="input" id="f-name" placeholder="Chiamaka Eze"></div>
        <div class="field"><label for="f-limit">Limit per invoice (₦)</label><input class="input mono" id="f-limit" inputmode="numeric" placeholder="800,000"></div>
        <div class="field"><label for="f-role">Role</label><input class="input" id="f-role" placeholder="Developer"></div>
        <div class="field" style="grid-column:1/-1"><label for="f-code">Their receiving code</label><input class="input mono" id="f-code" placeholder="st:celo:0x…"><span class="small muted">Ask them to send it from the Receiving code page. Check it with them on a call before saving.</span></div>
        <div style="grid-column:1/-1"><button class="btn btn-primary" type="submit">Save freelancer</button></div>
      </form>
    </section>`;
  }

  function access() {
    const s = D.session;
    const exp = new Date(s.expiresAt);
    const daysLeft = Math.max(0, Math.round((exp - new Date("2026-11-21T10:30:00Z")) / 86400000));
    return `${head({
      title: "Agent access",
      lede: "The agent holds a limited key to your wallet, not the wallet itself. These limits are enforced onchain.",
      actions: `<button class="btn btn-secondary" type="button">Re-sign Textile proof</button><button class="btn btn-primary" type="button">Revoke the agent's key</button>`,
    })}
    <section class="grid-3" aria-label="Limits">
      <article class="card stat">
        <span class="label">USD₮ the agent can spend</span>
        <span class="figure">${usdt(s.usdtPerWeek - s.usdtUsed)}<span class="unit">left of ${s.usdtPerWeek}</span></span>
        <div class="bar"><span style="width:${pct(s.usdtUsed, s.usdtPerWeek)}%"></span></div>
        <span class="note">Resets weekly</span>
      </article>
      <article class="card stat">
        <span class="label">Naira the agent can send</span>
        <span class="figure">${ngn(s.cngnPerWeek - s.cngnUsed)}</span>
        <div class="bar"><span style="width:${pct(s.cngnUsed, s.cngnPerWeek)}%"></span></div>
        <span class="note">left of ${ngn(s.cngnPerWeek)} this week</span>
      </article>
      <article class="card stat">
        <span class="label">Key expires</span>
        <span class="figure">${daysLeft}<span class="unit">days</span></span>
        <span class="note"><time>${exp.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</time>${badge("Active")}</span>
      </article>
    </section>
    <section class="grid-2" aria-label="Permissions">
      <article class="card">
        <div class="card-head"><h2>What the agent may do</h2><span class="small muted">Everything else is refused</span></div>
        <ul class="checks">${s.calls.map((c) => `<li><span class="ico">${icon("check")}</span><div><div class="strong">${esc(c.what)}</div><div class="small muted mono">${esc(c.detail)}</div></div><span></span></li>`).join("")}</ul>
      </article>
      <article class="card stack">
        <div class="card-head" style="margin-bottom:0"><h2>Your wallet</h2></div>
        <div class="code-box">${esc(D.client.wallet)}</div>
        <div class="callout">${icon("shield")}<span>Your own key never leaves this computer. Revoking takes effect in the next block, about one second on Celo.</span></div>
        <dl class="kv">
          <dt>Textile proof valid until</dt><dd><time>${new Date(s.proofValidUntil).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</time></dd>
          <dt>Fees paid in</dt><dd>USD₮</dd>
          <dt>ERC-8004 identity</dt><dd>Naira Reach</dd>
        </dl>
      </article>
    </section>`;
  }

  // ---------- Getting paid ----------
  function code() {
    const f = D.freelancer;
    return `${head({
      title: "Your receiving code",
      lede: "Share this code with clients instead of a wallet address. Every payment lands at a brand-new address that only you can open, so nobody can add up what you earn.",
    })}
    <section class="grid-2" aria-label="Receiving code">
      <article class="card stack">
        <div class="card-head" style="margin-bottom:0"><h2>Safe to share</h2>${badge("Private by design")}</div>
        <div class="code-box">${esc(f.code)}</div>
        <div class="row">
          <button class="btn btn-primary" type="button">${icon("copy")}Copy code</button>
          <button class="btn btn-secondary" type="button">${icon("download")}Back up my keys</button>
        </div>
        <div class="callout">${icon("info")}<span>Your keys stay in this browser. Back them up: without them, payouts can't be opened.</span></div>
      </article>
      <article class="card">
        <div class="card-head"><h2>How it works</h2></div>
        <ol class="checks" style="counter-reset:step">
          ${[
            ["Share your code once", "Send it to your client. It is not an address, and it can't be used to look up your money."],
            ["Get paid in naira", "Each invoice is paid in cNGN to a fresh address made from your code."],
            ["Move it when you want", "Open the payout here and send it to your wallet, or withdraw to your bank."],
          ].map(([t, d], i) => `<li><span class="ico mono small">${i + 1}</span><div><div class="strong">${t}</div><div class="small muted">${d}</div></div><span></span></li>`).join("")}
        </ol>
      </article>
    </section>`;
  }

  function payouts() {
    const f = D.freelancer;
    const ready = f.payouts.filter((p) => p.state === "Ready to move");
    const readyNgn = ready.reduce((a, p) => a + p.ngn, 0);
    return `${head({
      title: "Payouts",
      lede: "Open a receipt from your client to see the payout and move the naira.",
      actions: `<a class="btn btn-secondary" href="https://app.textilecredit.com/" target="_blank" rel="noopener">${icon("external")}Withdraw NGN to bank</a>`,
    })}
    <section class="grid-3" aria-label="Summary">
      <article class="card stat"><span class="label">Ready to move</span><span class="figure">${ngn(readyNgn)}</span><span class="note">${badge(ready.length + " payout")}</span></article>
      <article class="card stat"><span class="label">Received in total</span><span class="figure">${ngn(f.payouts.reduce((a, p) => a + p.ngn, 0))}</span><span class="note">${f.payouts.length} payouts, each to its own address</span></article>
      <article class="card stat"><span class="label">Gas money included</span><span class="figure">0.05<span class="unit">USD₮</span></span><span class="note">per payout, so moving it costs you nothing</span></article>
    </section>
    <section class="grid-2" aria-label="Payouts">
      <article class="card">
        <div class="card-head"><h2>Your payouts</h2><button class="btn btn-secondary btn-sm" type="button">${icon("upload")}Open a receipt</button></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Invoice</th><th class="hide-sm">Date</th><th class="hide-sm">Address</th><th class="amount">Amount</th></tr></thead>
          <tbody>${f.payouts.map((p) => `<tr>
            <td><span class="strong mono">${esc(p.invoice)}</span><span class="sub">${p.state === "Ready to move" ? "Ready to move" : "Moved"}</span></td>
            <td class="hide-sm"><time>${fmtDate(p.date)}</time></td>
            <td class="hide-sm mono small">${esc(p.address)}</td>
            <td class="amount">${ngn(p.ngn)}</td>
          </tr>`).join("")}</tbody>
        </table></div>
      </article>
      <article class="card stack">
        <div class="card-head" style="margin-bottom:0"><h2>Move ${ngn(ready[0] ? ready[0].ngn : 0)}</h2>${badge("INV-2026-014")}</div>
        <div class="field"><label for="to">Send to</label><input class="input mono" id="to" placeholder="0x… your wallet or exchange deposit address"></div>
        <button class="btn btn-primary" type="button">${icon("send")}Move naira</button>
        <p class="small muted">Gas is paid from the 0.05 USD₮ that came with this payout. To get naira in your bank account, send it to Textile and use Withdraw NGN.</p>
      </article>
    </section>`;
  }

  const VIEWS = { pay: { overview, invoice: payInvoice, freelancers, access }, get: { code, payouts } };

  // ---------- router ----------
  function render() {
    const [, mode = "pay", page] = (location.hash || "#/pay/overview").split("/");
    const m = VIEWS[mode] ? mode : "pay";
    const p = VIEWS[m][page] ? page : MENUS[m][0][0];
    document.querySelectorAll(".mode a").forEach((a) => a.setAttribute("aria-current", String(a.dataset.mode === m)));
    menu.innerHTML = MENUS[m].map(([id, label, ic]) => `<li><a href="#/${m}/${id}" ${id === p ? 'aria-current="page"' : ""}>${icon(ic)}${label}</a></li>`).join("");
    sideCard.innerHTML = m === "pay"
      ? `<span class="label">Agent key</span><span class="spread"><span class="strong">Active</span>${badge("7 days")}</span><div class="bar"><span style="width:${pct(D.session.usdtUsed, D.session.usdtPerWeek)}%"></span></div><span class="small muted mono">${usdt(D.session.usdtPerWeek - D.session.usdtUsed)} of ${D.session.usdtPerWeek} USD₮ left</span>`
      : `<span class="label">Your receiving code</span><span class="mono small clip">${esc(D.freelancer.code)}</span><a class="small" href="#/get/code">Copy or back up</a>`;
    view.innerHTML = VIEWS[m][p]();
    document.title = `${MENUS[m].find((x) => x[0] === p)[1]} · Naira Reach`;
    document.getElementById("sidebar").classList.remove("open");
  }
  window.addEventListener("hashchange", () => { render(); view.focus({ preventScroll: true }); window.scrollTo(0, 0); });
  document.getElementById("menu-toggle").addEventListener("click", (e) => {
    const sb = document.getElementById("sidebar");
    const open = sb.classList.toggle("open");
    e.currentTarget.setAttribute("aria-expanded", String(open));
  });
  render();
})();
