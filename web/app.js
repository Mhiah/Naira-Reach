// Naira Reach web app: one site, two sides. Plain JavaScript, no build step.
//  Send:    the agent. On the online site it runs in this browser (vendor/send.js),
//           with its keys locked by the client's password; on a laptop it runs
//           behind `npm run app`.
//  Receive: runs entirely in this browser. Receiving keys never leave it.
(function () {
  "use strict";
  const CFG = window.NR_CONFIG || { agent: false };
  const HOSTED = !CFG.agent; // the online site: the agent runs in this browser
  const R = window.NRReceive;
  const RPC = CFG.rpcUrl || "https://forno.celo.org";
  const view = document.getElementById("view");
  const menu = document.getElementById("menu");
  const sideCard = document.getElementById("side-card");
  const toastEl = document.getElementById("toast");

  // ---------- helpers ----------
  const ngn = (n) => "₦" + Number(n).toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const usdt = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const limit = (n) => (Number.isInteger(Number(n)) ? Number(n).toLocaleString("en-US") : usdt(n)); // 300, not 300.00
  const short = (a) => (a && a.length > 14 ? a.slice(0, 6) + "…" + a.slice(-4) : a || "");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmtDate = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const ago = (t) => (Date.now() - t < 60000 ? "just now" : `at ${new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`);
  const fmtTime = (t) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const today = () => new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };
  const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0).toFixed(1);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const first = (name) => String(name || "").trim().split(/\s+/)[0];

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
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    shield: '<path d="M12 3 4.5 6v6c0 4.4 3.2 7.9 7.5 9 4.3-1.1 7.5-4.6 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name]}</svg>`;
  const badge = (text, kind = "") => `<span class="badge ${kind}"><span class="dot"></span>${esc(text)}</span>`;
  const callout = (html, kind = "", ic = "info") => `<div class="callout ${kind}">${icon(ic)}<span>${html}</span></div>`;
  const empty = (ic, html) => `<div class="empty">${icon(ic)}${html}</div>`;
  const loading = (text) => `<div class="loading"><span class="spinner"></span>${esc(text)}</div>`;
  const txLink = (t) => `<a href="${esc(t.explorer)}" target="_blank" rel="noopener" aria-label="View transaction ${esc(t.hash)} on Celoscan">${esc(short(t.hash))}</a>`;

  let toastTimer;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4000);
  }

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      window.prompt(`Copy ${what.toLowerCase()}:`, text);
    }
  }

  function download(name, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = Object.assign(document.createElement("input"), { type: "file", accept });
      input.addEventListener("change", () => resolve(input.files && input.files[0]));
      input.click();
    });
  }

  const readText = (file) => file.text();
  async function readBase64(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /** Run an action from a button: disable it, show progress, report errors. */
  async function busy(btn, label, fn) {
    if (!btn || btn.disabled) return;
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${esc(label)}`;
    try {
      return await fn();
    } catch (e) {
      toast(e.message || String(e));
      throw e;
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.innerHTML = html;
      }
    }
  }

  // ---------- browser storage (Receive side) ----------
  const store = {
    get(k, fallback) {
      try {
        const v = localStorage.getItem("nr." + k);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("nr." + k, JSON.stringify(v));
        return true;
      } catch {
        toast("This browser won't save data. Back up your keys now.");
        return false;
      }
    },
  };

  // ---------- the agent (Send side) ----------
  let S = null; // last state from the agent
  let SAt = 0;
  let stateError = null;
  let dirty = false; // the person is typing: don't redraw under them

  // On the online site the agent is a script loaded only when Send is opened.
  let sendLoading = null;
  let sendLoadError = null;
  function loadSend() {
    if (window.NRSend) return Promise.resolve(window.NRSend);
    if (!sendLoading) {
      sendLoading = new Promise((resolve, reject) => {
        const s = Object.assign(document.createElement("script"), { src: "vendor/send.js" });
        s.onload = () => (window.NRSend ? resolve(window.NRSend) : reject(new Error("Send didn't load. Reload the page.")));
        s.onerror = () => {
          sendLoading = null;
          s.remove();
          reject(new Error("Send didn't load. Check your connection and reload the page."));
        };
        document.head.appendChild(s);
      });
    }
    return sendLoading;
  }
  const sendStatus = () => (window.NRSend ? window.NRSend.status() : "loading");
  const where = HOSTED ? "this browser" : "this computer";
  const onWhere = HOSTED ? "in this browser" : "on this computer";
  let importFile = null; // the locked file chosen on the set-up screen

  async function api(method, path, body) {
    if (HOSTED) return (await loadSend()).dispatch(method, path, body || {});
    // Every change is sent as JSON, even with nothing in it: the agent refuses anything else.
    const sendsBody = method !== "GET";
    const res = await fetch("/api" + path, {
      method,
      headers: { "x-naira-reach-token": CFG.token || "", ...(sendsBody ? { "content-type": "application/json" } : {}) },
      body: sendsBody ? JSON.stringify(body || {}) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `The agent answered ${res.status}.`);
    return out;
  }

  async function loadState() {
    if (HOSTED && sendStatus() !== "unlocked") {
      S = null;
      return;
    }
    try {
      S = await api("GET", "/state");
      SAt = Date.now();
      stateError = null;
    } catch (e) {
      stateError = e.message || "Can't reach the agent.";
    }
  }

  const activeSession = () => (S && S.session && !S.session.expired ? S.session : null);

  function head({ title, lede, actions = "" }) {
    return `<header class="page-head">
      <div><time class="date">${today()}</time><h1>${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ""}</div>
      ${actions ? `<div class="actions">${actions}</div>` : ""}
    </header>`;
  }

  function agentMissing(title) {
    if (CFG.agent) {
      return `${head({ title })}
    <section class="card stack" aria-label="Start the agent">
      <div class="card-head" style="margin-bottom:0"><h2>Start the agent</h2>${badge("Not answering", "neutral")}</div>
      <p>The agent stopped answering (${esc(stateError)}). Is the window running it still open?</p>
      <ol class="checks">
        <li><span class="ico todo">1</span><div><div class="strong">Open the Naira-Reach folder in a terminal</div></div><span></span></li>
        <li><span class="ico todo">2</span><div><div class="strong">Run <code>npm.cmd run app</code></div><div class="small muted">On Mac or Linux: <code>npm run app</code></div></div><span></span></li>
        <li><span class="ico todo">3</span><div><div class="strong">Reload this page</div></div><span></span></li>
      </ol>
    </section>`;
    }
    // Opened as a plain website (the online Receive site): Send can't run here.
    return `${head({ title })}
    <section class="card stack" aria-label="Start the agent">
      <div class="card-head" style="margin-bottom:0"><h2>Send runs on your own computer</h2>${badge("Not running here", "neutral")}</div>
      <p>The Send side runs the agent on the client's own computer, so the wallet key never leaves it. To pay freelancers:</p>
      <ol class="checks">
        <li><span class="ico todo">1</span><div><div class="strong">Get Naira Reach from <a href="https://github.com/Mhiah/Naira-Reach" target="_blank" rel="noopener">github.com/Mhiah/Naira-Reach</a></div><div class="small muted">Install it with the README's steps. It needs Node.js 22.18 or newer.</div></div><span></span></li>
        <li><span class="ico todo">2</span><div><div class="strong">In the Naira-Reach folder, run <code>npm.cmd run app</code></div><div class="small muted">On Mac or Linux: <code>npm run app</code></div></div><span></span></li>
        <li><span class="ico todo">3</span><div><div class="strong">Open <a href="http://localhost:8787">http://localhost:8787</a></div><div class="small muted">Keep the terminal open while you use it.</div></div><span></span></li>
      </ol>
      ${callout('Getting paid? You don\'t need any of this. <a href="#/get/code">Go to Receive</a> to create your receiving code.', "neutral")}
    </section>`;
  }

  // ---------- Send on the online site: set up, unlock ----------
  const safety = callout(
    "Your keys stay in this browser, locked with your password. Naira Reach's server only passes Textile's prices along; it never sees a key or your password. Clearing this browser's data deletes them, so download the locked backup from Agent access once you're set up. A forgotten password can't be reset.",
    "neutral",
    "shield",
  );

  function sendSetup(title) {
    const st = sendStatus();
    if (sendLoadError && st === "loading") return `${head({ title })}<section class="card">${callout(esc(sendLoadError), "", "flag")}</section>`;
    if (st === "loading") return `${head({ title })}${loading("Loading Send…")}`;
    if (st === "unlocked") {
      return stateError
        ? `${head({ title })}<section class="card stack">${callout(`The agent couldn't load your records: ${esc(stateError)}`, "", "flag")}<div><button class="btn btn-secondary" id="retry" type="button">Try again</button></div></section>`
        : `${head({ title })}${loading("Opening your agent…")}`;
    }
    if (st === "locked") {
      return `${head({ title: "Unlock Send", lede: "Your agent is in this browser, locked with your password." })}
      <section class="card narrow stack" aria-label="Unlock">
        <form class="stack" id="unlock-form" novalidate>
          <input type="text" name="username" value="Naira Reach Send" autocomplete="username" hidden>
          <div class="field"><label for="u-pw">Password</label><input class="input" type="password" id="u-pw" name="password" autocomplete="current-password" required></div>
          <div><button class="btn btn-primary" id="u-go" type="submit">${icon("lock")}Unlock</button></div>
        </form>
        <details class="small">
          <summary>Use a different agent</summary>
          <div class="stack" style="margin-top:12px">
            <p class="muted">This removes the agent from this browser. Your wallet and its money stay onchain; you can bring the agent back with its locked file and password.</p>
            <label class="check-line"><input type="checkbox" id="forget-ok"><span>I have the locked file and its password</span></label>
            <div><button class="btn btn-secondary btn-sm" id="forget" type="button" disabled>Remove it from this browser</button></div>
          </div>
        </details>
      </section>`;
    }
    return `${head({ title: "Set up Send", lede: "Create a wallet in this browser. The agent pays your freelancers' invoices from it, within the limits you set." })}
    <section class="grid-2" aria-label="Set up Send">
      <article class="card stack">
        <div class="card-head" style="margin-bottom:0"><h2>Create your wallet</h2></div>
        <form class="form-grid" id="new-form" novalidate>
          <input type="text" name="username" value="Naira Reach Send" autocomplete="username" hidden>
          <div class="field wide"><label for="n-name">Your name <span class="muted">(optional)</span></label><input class="input" id="n-name" name="clientName" autocomplete="name" maxlength="40"></div>
          <div class="field wide"><label for="n-pw">Password</label><input class="input" type="password" id="n-pw" name="password" autocomplete="new-password"></div>
          <div class="field wide"><label for="n-pw2">Repeat it</label><input class="input" type="password" id="n-pw2" name="repeat" autocomplete="new-password"></div>
          <div class="wide"><p class="small muted">At least 10 characters. It locks your wallet in this browser, and nobody can reset it for you.</p></div>
          <div class="wide"><button class="btn btn-primary" id="n-go" type="submit">${icon("key")}Create my wallet</button></div>
        </form>
      </article>
      <article class="card stack">
        <div class="card-head" style="margin-bottom:0"><h2>What you'll need</h2></div>
        <ol class="checks">
          <li><span class="ico todo">1</span><div><div class="strong">A password</div><div class="small muted">You type it each time you open Send</div></div><span></span></li>
          <li><span class="ico todo">2</span><div><div class="strong">About 21 CELO, once</div><div class="small muted">Altana's one-time fees: 10.2 to activate the wallet, 10.2 for the agent's key</div></div><span></span></li>
          <li><span class="ico todo">3</span><div><div class="strong">USD₮ on Celo</div><div class="small muted">What you pay invoices with. Freelancers receive naira (cNGN)</div></div><span></span></li>
        </ol>
        <details class="small">
          <summary>Already set up in another browser? Open your locked backup</summary>
          <form class="stack" id="import-form" novalidate style="margin-top:12px">
            <input type="text" name="username" value="Naira Reach Send" autocomplete="username" hidden>
            <div class="field"><span class="field-label">Locked backup file</span><div class="row"><button class="btn btn-secondary btn-sm" id="import-pick" type="button">${icon("upload")}Choose file</button><span class="small muted" id="import-name">${importFile ? esc(importFile.name) : "No file chosen"}</span></div></div>
            <div class="field"><label for="i-pw">Password</label><input class="input" type="password" id="i-pw" name="password" autocomplete="current-password"></div>
            <div><button class="btn btn-secondary" id="i-go" type="submit">Open my backup</button></div>
          </form>
        </details>
      </article>
    </section>
    <section class="card stack notes">${safety}${callout('Getting paid? You don\'t need any of this. <a href="#/get/code">Go to Receive</a> to create your receiving code.', "neutral")}</section>`;
  }

  // ---------- Send: Overview ----------
  function setupSteps() {
    const w = S.wallet;
    const live = w.live && w.live.ok ? w.live : null;
    const funded = live ? live.usdt > 0 : false;
    return [
      {
        done: Boolean(S.agent.attributionCode),
        title: "Attribution code",
        doneNote: `<span class="mono">${esc(S.agent.attributionCode)}</span>`,
        todo: "Add <code>ATTRIBUTION_CODE</code> from Loops House to <code>.env</code>, then restart the agent.",
      },
      {
        done: Boolean(w.address),
        title: `Wallet key ${onWhere}`,
        doneNote: `<span class="mono">${esc(short(w.address))}</span>`,
        todo: "In the Naira-Reach folder run <code>npm.cmd run reach -- wallet new-key</code>, then restart the agent.",
      },
      {
        done: funded,
        title: "USD₮ in your wallet",
        doneNote: live ? `${usdt(live.usdt)} USD₮` : "",
        todo: !w.address
          ? "Comes after the wallet key."
          : live
            ? `Send a few USD₮ on the <strong>Celo</strong> network to <code>${esc(w.address)}</code>
               <div class="step-action"><button class="btn btn-secondary btn-sm" data-copy="${esc(w.address)}" data-what="Address" type="button">${icon("copy")}Copy address</button></div>`
            : `Couldn't read the balance: ${esc(w.live ? w.live.error : "")}`,
      },
      {
        done: w.activated,
        title: "Wallet activated",
        doneNote: w.agentId ? `ERC-8004 agent #${esc(w.agentId)}` : "",
        todo: `Altana charges a one-time registration fee of about 10.2 CELO, and only CELO can pay it. Send about <strong>11 CELO</strong> on the Celo network to the same address${
          live && live.celo != null ? ` (it holds <span class="mono">${live.celo.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span> CELO now)` : ""
        }. The first transaction also registers Naira Reach's ERC-8004 identity.
          <div class="step-action"><button class="btn btn-primary btn-sm" id="activate" type="button" ${w.hasKey && funded ? "" : "disabled"}>Activate wallet</button></div>`,
      },
      {
        done: Boolean(activeSession()),
        title: "The agent has a key",
        doneNote: activeSession() ? `until ${fmtDate(activeSession().expiresAt)}` : "",
        todo: `Limits you choose, enforced onchain. <a href="#/pay/access">Give the agent a key</a>`,
      },
      {
        done: S.freelancers.length > 0,
        title: "A freelancer on your list",
        doneNote: plural(S.freelancers.length, "freelancer", "freelancers"),
        todo: `Add them with the receiving code they send you. <a href="#/pay/freelancers">Add a freelancer</a>`,
      },
    ];
  }

  function overview() {
    const w = S.wallet;
    const live = w.live && w.live.ok ? w.live : null;
    const ses = activeSession();
    const weekStart = S.weekly.starts[S.weekly.starts.length - 1];
    const thisWeek = S.payouts.filter((p) => p.kind === "paid" && Date.parse(p.at) >= weekStart);
    const weekNgn = thisWeek.reduce((a, p) => a + p.amountNgn, 0);
    const steps = setupSteps();
    const todo = steps.filter((s) => !s.done).length;
    const name = S.agent.clientName ? `, ${esc(S.agent.clientName)}` : "";
    const everPaid = S.payouts.some((p) => p.kind === "paid");

    const setup = todo
      ? `<section class="card" aria-label="Set up">
          <div class="card-head"><h2>Set up</h2><span class="small muted">${steps.length - todo} of ${steps.length} done</span></div>
          <ol class="checks">${steps.map((s, i) => `<li>
            <span class="ico ${s.done ? "" : "todo"}">${s.done ? icon("check") : i + 1}</span>
            <div><div class="strong">${s.title}</div><div class="small muted">${s.done ? s.doneNote : s.todo}</div></div>
            ${s.done ? badge("Done") : "<span></span>"}
          </li>`).join("")}</ol>
        </section>`
      : "";

    // Private delivery: payouts announced on Celo so freelancers find them without a receipt.
    const d = S.delivery;
    const delivery =
      d && w.hasKey && w.activated && (!d.live || d.pending)
        ? `<section class="card" aria-label="Automatic delivery">
          <div class="spread">
            <div>
              <h2 style="font-size:var(--fs-card)">${d.live ? `Deliver ${plural(d.pending, "earlier payout", "earlier payouts")}` : "Turn on automatic delivery"}</h2>
              <p class="small muted" style="margin-top:4px;max-width:640px">${
                d.live
                  ? "Announce them on Celo so your freelancers see them on Receive by themselves. A small Altana fee in USD₮."
                  : "Each payout gets a small public announcement on Celo that only its freelancer's keys can recognise, so it shows up on their Receive side by itself. No receipts to send. This adds the standard ERC-5564 announcer to Celo once, then announces your earlier payouts. Small Altana fees in USD₮."
              }</p>
            </div>
            <button class="btn btn-primary" type="button" id="delivery-setup">${icon("send")}${d.live ? "Deliver them" : "Turn it on"}</button>
          </div>
        </section>`
        : "";

    return `${head({
      title: `${greeting()}${name}`,
      lede: "Your agent settles invoices in naira from your own wallet, within the limits you set.",
      actions: `<a class="btn btn-secondary" href="#/pay/access">${icon("key")}Agent access</a><a class="btn btn-primary" href="#/pay/invoice">${icon("invoice")}Pay an invoice</a>`,
    })}
    ${setup}
    ${delivery}
    <section class="grid-3" aria-label="Summary">
      <article class="card stat">
        <span class="label">Wallet balance</span>
        <span class="figure">${live ? usdt(live.usdt) : "–"}<span class="unit">USD₮</span></span>
        <span class="note">${w.address ? `<span class="mono">${esc(short(w.address))}</span>${badge(w.activated ? "Altana wallet" : "Not activated", "neutral")}` : "No wallet yet"}</span>
      </article>
      <article class="card stat">
        <span class="label">Paid out this week</span>
        <span class="figure">${ngn(weekNgn)}</span>
        <span class="note">${badge(plural(thisWeek.length, "payout", "payouts"))}to ${plural(new Set(thisWeek.map((p) => p.freelancerId)).size, "freelancer", "freelancers")}</span>
      </article>
      <article class="card stat">
        <span class="label">Agent limit left this week</span>
        ${ses && ses.usdtPerWeek
          ? `<span class="figure">${usdt(Math.max(0, ses.usdtPerWeek - ses.used.usdt))}<span class="unit">of ${limit(ses.usdtPerWeek)} USD₮</span></span>
             <div class="bar" role="img" aria-label="${pct(ses.used.usdt, ses.usdtPerWeek)}% used"><span style="width:${pct(ses.used.usdt, ses.usdtPerWeek)}%"></span></div>`
          : `<span class="figure">–</span><span class="note">The agent has no key. <a href="#/pay/access">Give it one</a></span>`}
      </article>
    </section>
    <section class="grid-2" aria-label="Activity">
      <article class="card chart">
        <div class="card-head"><h2>Naira delivered</h2>${everPaid ? `<div class="legend"><span><i></i>Naira paid</span>${ses && ses.cngnPerWeek ? '<span><i class="dash"></i>Weekly limit</span>' : ""}</div>` : ""}</div>
        ${everPaid ? lineChart() : empty("inbox", "<p>Your payouts will show here, week by week.</p>")}
      </article>
      <article class="card">
        <div class="card-head"><h2>Today's rate</h2><span class="small muted">Textile FX</span></div>
        ${S.rate.ok
          ? `<div class="stat"><span class="figure">${ngn(S.rate.ngnPerUsdt.toFixed(2))}</span><span class="note">for 1 USD₮ · fee ${usdt(S.rate.feePer100Usdt)} USD₮ per 100${S.rate.asOf && Date.now() - S.rate.asOf > 120000 ? ` · as of ${new Date(S.rate.asOf).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : ""}</span></div>`
          : `<div class="stat"><span class="figure">–</span><span class="note">No price right now: ${esc(S.rate.error)}</span></div>`}
        <hr class="divider">
        <h3 class="small muted" style="font-family:var(--font-body);font-weight:400;letter-spacing:0;margin-bottom:var(--s3)">Paid to each freelancer</h3>
        ${S.freelancers.length
          ? `<ul class="list">${S.freelancers.map((f) => `<li><div class="meta"><span class="strong">${esc(f.name)}</span><span class="small muted">${plural(f.paid, "invoice", "invoices")}</span></div><span class="amount">${ngn(f.totalNgn)}</span></li>`).join("")}</ul>`
          : `<p class="small muted">No one on your list yet. <a href="#/pay/freelancers">Add a freelancer</a></p>`}
      </article>
    </section>
    <section class="card" aria-label="Recent payouts">
      <div class="card-head"><h2>Recent payouts</h2>${S.freelancers.length ? '<a class="small" href="#/pay/freelancers">All freelancers</a>' : ""}</div>
      ${S.payouts.length ? payoutsTable(S.payouts.slice(0, 8)) : empty("invoice", `<p>No payouts yet.</p><a class="btn btn-secondary btn-sm" href="#/pay/invoice">Pay your first invoice</a>`)}
    </section>`;
  }

  function payoutsTable(rows) {
    return `<div class="table-wrap"><table>
      <thead><tr><th>Freelancer</th><th class="hide-sm">Date</th><th class="hide-sm">Status</th><th class="hide-sm">Transaction</th><th class="amount">Amount</th></tr></thead>
      <tbody>${rows.map((p) => `<tr>
        <td><span class="strong">${esc(p.kind === "held" ? `“${p.who}”` : p.who)}</span><span class="sub"><span class="mono">${esc(p.invoiceId)}</span>${p.kind === "held" && p.reasons[0] ? " · " + esc(p.reasons[0].replace(`"${p.who}" is not`, "Not")) : ""}</span></td>
        <td class="hide-sm"><time>${fmtDate(p.at)}</time></td>
        <td class="hide-sm">${p.kind === "paid" ? badge("Paid") : badge("Held", "neutral")}</td>
        <td class="hide-sm mono small">${p.kind === "paid" && p.transactions[0]
          ? `${txLink(p.transactions[0])}${p.receipt ? `<span class="sub"><button class="btn-link" type="button" data-receipt="${esc(p.receipt)}" data-invoice="${esc(p.invoiceId)}">Receipt</button></span>` : ""}`
          : '<span class="muted">Nothing sent</span>'}</td>
        <td class="amount">${ngn(p.amountNgn)}${p.kind === "paid" && p.usdt != null ? `<span class="sub">${usdt(p.usdt)} USD₮</span>` : ""}</td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  }

  function lineChart() {
    // Naira paid each week, against the agent's weekly naira limit.
    const labels = S.weekly.starts.map((t) => new Date(t).toLocaleDateString("en-GB", { month: "short", day: "numeric", timeZone: "UTC" }));
    const vals = S.weekly.ngn;
    const ses = activeSession();
    const limit = ses && ses.cngnPerWeek ? ses.cngnPerWeek : 0;
    const W = 640, H = 220, P = { l: 4, r: 4, t: 12, b: 4 };
    const max = Math.max(...vals, limit, 1) * 1.1;
    const x = (i) => P.l + (i * (W - P.l - P.r)) / (labels.length - 1);
    const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
    const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const area = `${line} L${x(labels.length - 1)},${H - P.b} L${x(0)},${H - P.b} Z`;
    const grid = [0.25, 0.5, 0.75].map((f) => { const gy = (P.t + f * (H - P.t - P.b)).toFixed(1); return `<line x1="${P.l}" x2="${W - P.r}" y1="${gy}" y2="${gy}" stroke="var(--color-border)" stroke-width="1" vector-effect="non-scaling-stroke"/>`; }).join("");
    return `<div class="plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Naira paid per week over the last seven weeks, ${ngn(vals[vals.length - 1])} this week${limit ? `, against a weekly limit of ${ngn(limit)}` : ""}">
      ${grid}
      <path d="${area}" fill="color-mix(in srgb, var(--color-primary) 7%, transparent)"/>
      ${limit ? `<line x1="${P.l}" x2="${W - P.r}" y1="${y(limit).toFixed(1)}" y2="${y(limit).toFixed(1)}" stroke="var(--color-secondary)" stroke-width="2" stroke-dasharray="6 6" vector-effect="non-scaling-stroke"/>` : ""}
      <path d="${line}" fill="none" stroke="var(--color-primary)" stroke-width="2.25" vector-effect="non-scaling-stroke"/>
    </svg><div class="ticks" aria-hidden="true">${labels.map((l) => `<span>${l}</span>`).join("")}</div></div>`;
  }

  // ---------- Send: Pay an invoice ----------
  let INV = null; // { id, fileName, review, result, paying, override }
  let lastInvoiceData = null; // the uploaded bytes, so the price can be checked again

  function payInvoice() {
    const r = INV && INV.review;
    const reader = S.agent.aiReader ? ".json or .txt" : ".json";
    const left = `<div class="stack">
      <article class="card">
        <div class="card-head"><h2>Invoice</h2><span class="small muted">${reader}</span></div>
        <div class="drop" id="drop">
          ${icon("upload")}
          <p class="strong">Drop an invoice here</p>
          <p class="small muted">${S.agent.aiReader ? "Contact and bank details are removed before the AI reads it." : HOSTED ? "Online, invoices are read from .json files. Plain-text invoices need the laptop version's AI reader." : "Plain-text invoices need the AI reader: add ANTHROPIC_API_KEY to .env."}</p>
          <button class="btn btn-secondary btn-sm" type="button" id="choose">Choose a file</button>
        </div>
      </article>
      ${r ? `<article class="card">
        <div class="card-head"><h3>${esc(INV.fileName)}</h3>${badge(r.source === "ai" ? "Read by AI" : "Read from JSON")}</div>
        <dl class="kv">
          <dt>From</dt><dd style="font-family:var(--font-body)">${esc(r.invoice.freelancer)}</dd>
          <dt>Invoice</dt><dd>${esc(r.invoice.invoiceId)}</dd>
          ${r.invoice.description ? `<dt>Work</dt><dd style="font-family:var(--font-body)">${esc(r.invoice.description)}</dd>` : ""}
          <dt>Amount billed</dt><dd class="total">${ngn(r.invoice.amountNgn)}</dd>
        </dl>
      </article>` : ""}
    </div>`;

    let right;
    if (!r) {
      right = `<div class="stack"><article class="card">
        <div class="card-head"><h2>Checks</h2></div>
        ${empty("shield", "<p>Add an invoice and the agent checks who is billing, whether it was paid before, and what it costs. Nothing moves until you approve.</p>")}
      </article></div>`;
    } else {
      const passed = r.rows.filter((c) => c.ok).length;
      const checks = `<article class="card">
        <div class="card-head"><h2>Checks</h2><span class="small muted">${passed} of ${r.rows.length} passed</span></div>
        <ul class="checks">${r.rows.map((c) => `<li>
          <span class="ico ${c.ok ? "" : "flag"}">${icon(c.ok ? "check" : "flag")}</span>
          <div><div class="strong">${esc(c.title)}</div><div class="small muted">${esc(c.note)}</div></div>
          ${c.ignored ? badge("Ignored") : c.hold ? badge("Held", "neutral") : ""}
        </li>`).join("")}</ul>
      </article>`;
      right = `<div class="stack">${checks}${INV.result ? resultCard() : quoteCard(r)}</div>`;
    }
    return `${head({
      title: "Pay an invoice",
      lede: "The agent reads the invoice, checks it, and prices the exact naira billed. Nothing moves until you approve.",
    })}
    <section class="grid-2-even" aria-label="Invoice and checks">${left}${right}</section>`;
  }

  const approveLimit = (r) => Math.ceil((r.price.usdtCost * 1.01 + 1e-9) * 100) / 100;

  function quoteCard(r) {
    if (!r.price) {
      return `<article class="card stack">
        <div class="card-head" style="margin-bottom:0"><h2>Held</h2>${badge("Nothing sent", "neutral")}</div>
        <p>${r.freelancer ? "The agent can't price this invoice right now." : "The agent only pays people on your list, at the private code they gave you."}</p>
        <div class="row"><button class="btn btn-secondary" type="button" id="clear">Choose another invoice</button></div>
      </article>`;
    }
    const p = r.price;
    const blocked = r.holds.length > 0 && !r.canOverride;
    const needsOverride = r.holds.length > 0 && r.canOverride;
    const canPay = !blocked && (!needsOverride || INV.override) && !INV.paying;
    const who = r.freelancer ? first(r.freelancer.name) : "They";
    return `<article class="card">
      <div class="card-head"><h2>Quote</h2>${badge("Indicative", "neutral")}</div>
      <dl class="kv">
        <dt>${esc(who)} receives</dt><dd>${ngn(r.invoice.amountNgn)}</dd>
        <dt>Rate</dt><dd>${ngn(p.ngnPerUsdt.toFixed(2))} / USD₮</dd>
        <dt>Textile fee</dt><dd>${usdt(p.feeUsdt)} USD₮</dd>
        <dt>Gas money for ${esc(who)}</dt><dd>${usdt(p.gasMoneyUsdt)} USD₮</dd>
      </dl>
      <hr class="divider">
      <div class="spread"><span class="strong">You pay about</span><span class="mono total" style="font-size:var(--fs-section);font-weight:700">${usdt(p.usdtCost + p.gasMoneyUsdt)} USD₮</span></div>
      ${needsOverride ? `<label class="check-line" style="margin-top:var(--s5)"><input type="checkbox" id="override" ${INV.override ? "checked" : ""}><span>I've checked the held items with ${esc(who)}. Pay anyway.</span></label>` : ""}
      <div class="row" style="margin-top:var(--s5)">
        <button class="btn btn-secondary" type="button" id="clear" ${INV.paying ? "disabled" : ""}>Cancel</button>
        <button class="btn btn-primary" type="button" id="pay" style="flex:1" ${canPay ? "" : "disabled"}>${INV.paying ? '<span class="spinner"></span>Paying… keep this page open' : `${icon("send")}Approve and pay`}</button>
      </div>
      <p class="small muted" style="margin-top:var(--s3)">${blocked
        ? "This can't be paid until the held items are fixed."
        : `You approve up to <span class="mono">${usdt(approveLimit(r))}</span> USD₮ for the swap. The agent locks a firm price, and if it is higher, nothing is sent. Approve, swap, payout and gas money go through as one transaction: all of it or none of it.`}</p>
    </article>`;
  }

  function resultCard() {
    const x = INV.result;
    if (x.status === "paid") {
      return `<article class="card stack">
        <div class="card-head" style="margin-bottom:0"><h2>Paid</h2>${badge("Done")}</div>
        <p><span class="strong">${ngn(x.amountNgn)}</span> is with ${esc(x.freelancer)}, at a private address only they can open.</p>
        <dl class="kv">
          <dt>Cost</dt><dd>${usdt(x.usdt)} USD₮</dd>
          <dt>Private payout address</dt><dd>${esc(short(x.payoutAddress))}</dd>
          ${x.transactions.map((t) => `<dt>Transaction</dt><dd>${txLink(t)} ${t.tagged ? badge("Tagged") : badge("Tag not seen", "neutral")}</dd>`).join("")}
        </dl>
        ${x.delivered
          ? callout(`Delivered: ${esc(first(x.freelancer))} will see it on their Receive side by itself. The receipt is for your records.`, "", "shield")
          : callout(`Send ${esc(first(x.freelancer))} the receipt. It holds what they need to open the payout, and nothing personal.`)}
        <div class="row">
          <button class="btn btn-primary" type="button" data-receipt="${esc(x.receipt)}" data-invoice="${esc(x.invoiceId)}">${icon("download")}Download receipt</button>
          <button class="btn btn-secondary" type="button" id="clear">Pay another invoice</button>
        </div>
      </article>`;
    }
    if (x.status === "held") {
      return `<article class="card stack">
        <div class="card-head" style="margin-bottom:0"><h2>Held</h2>${badge("Nothing sent", "neutral")}</div>
        <ul class="checks">${x.holds.map((h) => `<li><span class="ico flag">${icon("flag")}</span><div class="small">${esc(h)}</div><span></span></li>`).join("")}</ul>
        <div class="row"><button class="btn btn-secondary" type="button" id="recheck">Check the price again</button></div>
      </article>`;
    }
    return `<article class="card stack">
      <div class="card-head" style="margin-bottom:0"><h2>Not confirmed</h2>${badge("Check before retrying", "neutral")}</div>
      <p>The transaction did not confirm. Look it up before paying again, so the invoice isn't paid twice.</p>
      <dl class="kv">${(x.transactions || []).map((t) => `<dt>Transaction</dt><dd>${txLink(t)}</dd>`).join("") || "<dt>Transaction</dt><dd>none sent</dd>"}</dl>
      <div class="row"><button class="btn btn-secondary" type="button" id="clear">Close</button></div>
    </article>`;
  }

  async function uploadInvoice(file) {
    if (!file) return;
    if (file.size > 1024 * 1024) return toast("Invoices up to 1 MB only.");
    INV = { fileName: file.name, review: null, result: null, paying: false, override: false };
    view.querySelector("#drop").innerHTML = loading(`Reading ${file.name}…`);
    try {
      lastInvoiceData = await readBase64(file);
      const out = await api("POST", "/invoices", { name: file.name, data: lastInvoiceData });
      INV.review = out;
      INV.id = out.id;
      if (out.holds.length) loadState(); // a held invoice now shows on the overview
    } catch (e) {
      INV = null;
      toast(e.message);
    }
    render();
  }

  async function payNow() {
    const r = INV.review;
    INV.paying = true;
    render();
    try {
      INV.result = await api("POST", `/invoices/${INV.id}/pay`, { approvedUsdt: approveLimit(r), approveHolds: Boolean(INV.override) });
      if (INV.result.status === "paid") toast(`Paid ${ngn(INV.result.amountNgn)} to ${INV.result.freelancer}`);
    } catch (e) {
      toast(e.message);
    } finally {
      INV.paying = false;
      await loadState();
      render();
    }
  }

  async function downloadReceipt(name, invoiceId) {
    try {
      const data = await api("GET", `/receipts/${encodeURIComponent(name)}`);
      download(`naira-reach-receipt-${String(invoiceId || "payout").replace(/[^A-Za-z0-9_-]+/g, "_")}.json`, data);
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- Send: Freelancers ----------
  // With nobody on the list, the form is shown straight away. After that it stays
  // closed until "Add a freelancer" at the top opens it.
  let addOpen = false;

  function freelancers() {
    const hasList = S.freelancers.length > 0;
    const showForm = !hasList || addOpen;
    const form = `<section class="card" aria-label="Add a freelancer" id="add-freelancer">
      <div class="card-head"><h2>Add a freelancer</h2></div>
      <form class="form-grid" id="f-form" novalidate>
        <div class="field"><label for="f-name">Name, as on their invoices</label><input class="input" id="f-name" name="name" autocomplete="off" placeholder="Ada Obi" required></div>
        <div class="field"><label for="f-role">Role</label><input class="input" id="f-role" name="role" autocomplete="off" placeholder="Writer"></div>
        <div class="field"><label for="f-limit">Limit per invoice (₦)</label><input class="input mono" id="f-limit" name="maxInvoiceNgn" inputmode="numeric" placeholder="500,000"></div>
        <div class="field"><label for="f-aliases">Other names on their invoices</label><input class="input" id="f-aliases" name="aliases" autocomplete="off" placeholder="ada, Ada O."><span class="hint">Separate with commas.</span></div>
        <div class="field"><label for="f-agreed">Fixed amount, if any (₦)</label><input class="input mono" id="f-agreed" name="agreedNgn" inputmode="numeric" placeholder="Leave empty"><span class="hint">Every invoice must match it exactly.</span></div>
        <div class="field wide"><label for="f-code">Their receiving code</label><input class="input mono" id="f-code" name="metaAddress" autocomplete="off" spellcheck="false" placeholder="st:celo:0x…" required><span class="hint">They get it from the Receive side of this site. Check it with them on a call before saving.</span></div>
        <div class="wide row">
          ${hasList ? '<button class="btn btn-secondary" type="button" id="f-cancel">Cancel</button>' : ""}
          <button class="btn btn-primary" type="submit" id="f-save">Save freelancer</button>
        </div>
      </form>
    </section>`;
    return `${head({
      title: "Freelancers",
      lede: "The agent only pays people on this list, and only to the private code they shared with you. Addresses written on invoices are ignored.",
      actions: showForm ? "" : `<button class="btn btn-primary" type="button" id="to-add">${icon("plus")}Add a freelancer</button>`,
    })}
    ${hasList && showForm ? form : ""}
    <section class="card" aria-label="Approved freelancers">
      ${S.freelancers.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th class="hide-sm">Receiving code</th><th class="hide-sm amount">Limit per invoice</th><th class="hide-sm amount">Invoices paid</th><th class="amount">Total paid</th><th class="amount"><span class="hide-sm">Remove</span></th></tr></thead>
        <tbody>${S.freelancers.map((f) => `<tr>
          <td><span class="strong">${esc(f.name)}</span><span class="sub">${esc(f.role || (f.aliases && f.aliases.length ? "Also: " + f.aliases.join(", ") : ""))}</span></td>
          <td class="hide-sm mono small">${esc(f.metaAddress.slice(0, 26))}…${esc(f.metaAddress.slice(-4))}</td>
          <td class="hide-sm amount">${f.agreedNgn ? `${ngn(f.agreedNgn)}<span class="sub">agreed amount</span>` : f.maxInvoiceNgn ? ngn(f.maxInvoiceNgn) : '<span class="muted">No limit</span>'}</td>
          <td class="hide-sm amount">${f.paid}</td>
          <td class="amount">${ngn(f.totalNgn)}</td>
          <td class="amount"><button class="btn-link" type="button" data-remove="${esc(f.id)}" data-name="${esc(f.name)}" aria-label="Remove ${esc(f.name)}">Remove</button></td>
        </tr>`).join("")}</tbody>
      </table></div>` : empty("people", "<p>No one on your list yet. The agent holds every invoice until you add the person billing.</p>")}
    </section>
    ${!hasList ? form : ""}`;
  }

  // ---------- Send: Agent access ----------
  function access() {
    const w = S.wallet;
    const ses = activeSession();
    const expired = S.session && S.session.expired;
    const proofOk = S.proof && S.proof.fresh;
    const keyless = S.agent.textile === "keyless";

    const walletCard = `<article class="card stack">
      <div class="card-head" style="margin-bottom:0"><h2>Your wallet</h2>${w.address ? `<button class="btn btn-secondary btn-sm" type="button" data-copy="${esc(w.address)}" data-what="Address">${icon("copy")}Copy</button>` : ""}</div>
      ${w.address ? `<div class="code-box">${esc(w.address)}</div>` : `<p class="muted">No wallet key ${onWhere} yet.</p>`}
      ${callout(`Your own key never leaves ${where}. Revoking takes effect in the next block, about one second on Celo.`, "", "shield")}
      <dl class="kv">
        ${keyless ? (S.proof && proofOk
          ? `<dt>Textile proof valid until</dt><dd><time>${new Date(S.proof.validUntil).toDateString() === new Date().toDateString() ? new Date(S.proof.validUntil).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : fmtTime(S.proof.validUntil)}</time></dd>`
          : `<dt>Textile proof</dt><dd>${S.proof ? "expired" : "not signed yet"}</dd>`) : ""}
        <dt>Fees paid in</dt><dd>USD₮</dd>
        <dt>ERC-8004 identity</dt><dd>${w.agentId ? (w.agentPage ? `<a href="${esc(w.agentPage)}" target="_blank" rel="noopener">Agent #${esc(w.agentId)}</a>` : `Agent #${esc(w.agentId)}`) : w.activated ? "Naira Reach" : "After activation"}</dd>
      </dl>
    </article>`;

    const placeCard = HOSTED
      ? `<section class="card stack" aria-label="This browser">
          <div class="card-head" style="margin-bottom:0"><h2>Kept in this browser</h2>${badge("Locked with your password", "neutral")}</div>
          <p class="small muted">Your wallet key, the agent's key and your records are kept here, locked. Download the locked backup and keep it somewhere safe: with it and your password you can open Send in any browser.</p>
          <div class="row"><button class="btn btn-secondary" id="backup-send" type="button">${icon("download")}Download locked backup</button><button class="btn btn-secondary" id="lock-send" type="button">${icon("lock")}Lock Send</button></div>
        </section>`
      : `<section class="card stack" aria-label="Move to the online site">
          <div class="card-head" style="margin-bottom:0"><h2>Move to the online site</h2>${badge("Same wallet", "neutral")}</div>
          <p class="small muted">Puts this agent (your wallet key, the agent's key, your freelancers and receipts) in one file, locked with a password you choose. On the online site, open Send and choose <strong>Open your locked backup</strong>. Use one place at a time: payouts made in one don't show in the other.</p>
          <form class="form-grid" id="export-form" novalidate>
          <input type="text" name="username" value="Naira Reach Send" autocomplete="username" hidden>
            <div class="field"><label for="x-pw">Password</label><input class="input" type="password" id="x-pw" name="password" autocomplete="new-password"></div>
            <div class="field"><label for="x-pw2">Repeat it</label><input class="input" type="password" id="x-pw2" name="repeat" autocomplete="new-password"></div>
            <div class="wide"><button class="btn btn-secondary" id="x-go" type="submit" ${w.hasKey ? "" : "disabled"}>${icon("download")}Download the locked file</button></div>
          </form>
        </section>`;

    if (!ses) {
      const ready = w.hasKey && w.activated;
      return `${head({
        title: "Agent access",
        lede: "The agent holds a limited key to your wallet, not the wallet itself. These limits are enforced onchain.",
      })}
      <section class="grid-2" aria-label="Give the agent a key">
        <article class="card">
          <div class="card-head"><h2>Give the agent a key</h2>${expired ? badge("Last key expired", "neutral") : ""}</div>
          <form class="form-grid" id="g-form" novalidate>
            <div class="field"><label for="g-usdt">USD₮ per week</label><input class="input mono" id="g-usdt" name="usdtPerWeek" inputmode="decimal" value="200"></div>
            <div class="field"><label for="g-cngn">Naira per week (₦)</label><input class="input mono" id="g-cngn" name="cngnPerWeek" inputmode="numeric" value="300,000"></div>
            <div class="field"><label for="g-days">Lasts (days)</label><input class="input mono" id="g-days" name="days" inputmode="numeric" value="7"></div>
            <div class="wide stack">
              <p class="small muted">It may only approve USD₮, swap on Textile FX, and send cNGN and gas money. Everything else is refused onchain. You sign this with your own key, ${onWhere}.</p>
              <p class="small muted">Each new key is listed publicly in Altana's KeyStore, which charges a one-time fee of about <strong>10.2 CELO</strong> per key. Keep that much CELO in the wallet before you click.</p>
              <div><button class="btn btn-primary" type="submit" id="g-save" ${ready ? "" : "disabled"}>${icon("key")}Give the agent a key</button></div>
              ${ready ? "" : callout(w.hasKey ? 'Activate your wallet first, on the <a href="#/pay/overview">Overview</a>.' : 'Add your wallet key first. The <a href="#/pay/overview">Overview</a> shows how.', "neutral")}
            </div>
          </form>
        </article>
        ${walletCard}
      </section>
      ${placeCard}`;
    }

    const daysLeft = Math.max(0, Math.ceil((ses.expiresAt - Date.now()) / 86400000));
    return `${head({
      title: "Agent access",
      lede: "The agent holds a limited key to your wallet, not the wallet itself. These limits are enforced onchain.",
      actions: `${keyless ? `<button class="btn btn-secondary" type="button" id="proof">Re-sign Textile proof</button>` : ""}<button class="btn btn-primary" type="button" id="revoke">Revoke the agent's key</button>`,
    })}
    ${keyless && !proofOk ? callout("Textile's wallet proof has expired. Re-sign it before paying: it lets the agent get firm quotes for your wallet for the next 11 hours.", "", "flag") : ""}
    <section class="grid-3" aria-label="Limits">
      <article class="card stat">
        <span class="label">USD₮ the agent can spend</span>
        <span class="figure">${usdt(Math.max(0, ses.usdtPerWeek - ses.used.usdt))}<span class="unit">left of ${limit(ses.usdtPerWeek)}</span></span>
        <div class="bar"><span style="width:${pct(ses.used.usdt, ses.usdtPerWeek)}%"></span></div>
        <span class="note">Resets weekly</span>
      </article>
      <article class="card stat">
        <span class="label">Naira the agent can send</span>
        <span class="figure">${ngn(Math.max(0, ses.cngnPerWeek - ses.used.cngn))}</span>
        <div class="bar"><span style="width:${pct(ses.used.cngn, ses.cngnPerWeek)}%"></span></div>
        <span class="note">left of ${ngn(ses.cngnPerWeek)} this week</span>
      </article>
      <article class="card stat">
        <span class="label">Key expires</span>
        <span class="figure">${daysLeft}<span class="unit">${daysLeft === 1 ? "day" : "days"}</span></span>
        <span class="note"><time>${fmtDate(ses.expiresAt)}</time>${badge("Active")}</span>
        <span class="note">A new key costs about 10.2 CELO</span>
      </article>
    </section>
    <section class="grid-2" aria-label="Permissions">
      <article class="card">
        <div class="card-head"><h2>What the agent may do</h2><span class="small muted">Everything else is refused</span></div>
        <ul class="checks">${ses.calls.map((c) => `<li><span class="ico">${icon("check")}</span><div><div class="strong">${esc(c.what)}</div><div class="small muted mono">${esc(c.detail)}</div></div><span></span></li>`).join("")}</ul>
      </article>
      ${walletCard}
    </section>
    ${placeCard}`;
  }

  // ---------- Receive: Receiving code ----------
  function code() {
    const keys = store.get("keys", null);
    const how = `<article class="card">
      <div class="card-head"><h2>How it works</h2></div>
      <ol class="checks">
        ${[
          ["Share your code once", "Send it to your client. It is not an address, and it can't be used to look up your money."],
          ["Get paid in naira", "Each invoice is paid in cNGN to a fresh address made from your code."],
          ["Move it when you want", "Open the payout here and send it to your wallet, or withdraw to your bank."],
        ].map(([t, d], i) => `<li><span class="ico mono small">${i + 1}</span><div><div class="strong">${t}</div><div class="small muted">${d}</div></div><span></span></li>`).join("")}
      </ol>
    </article>`;
    if (!keys) {
      return `${head({
        title: "Your receiving code",
        lede: "Give clients a code, not a wallet address. Only you can open what they send.",
      })}
      <section class="grid-2" aria-label="Receiving code">
        <article class="card stack">
          <div class="card-head" style="margin-bottom:0"><h2>Create your code</h2>${badge("Private by design")}</div>
          <p>Your keys are created here, in this browser, and stay here. Nothing is sent anywhere.</p>
          <div class="row">
            <button class="btn btn-primary" type="button" id="make-keys">${icon("key")}Create my receiving code</button>
            <button class="btn btn-secondary" type="button" id="restore">${icon("upload")}Restore a backup</button>
          </div>
        </article>
        ${how}
      </section>`;
    }
    const backedUp = store.get("backedUp", false);
    return `${head({
      title: "Your receiving code",
      lede: "Give clients this code, not a wallet address. Only you can open what they send.",
    })}
    <section class="grid-2" aria-label="Receiving code">
      <article class="card stack">
        <div class="card-head" style="margin-bottom:0"><h2>Safe to share</h2>${badge("Private by design")}</div>
        <div class="code-box">${esc(keys.metaAddress)}</div>
        <div class="row">
          <button class="btn btn-primary" type="button" data-copy="${esc(keys.metaAddress)}" data-what="Code">${icon("copy")}Copy code</button>
          <button class="btn btn-secondary" type="button" id="backup">${icon("download")}Back up my keys</button>
        </div>
        ${backedUp
          ? callout("Your keys stay in this browser. Keep the backup file somewhere safe and private: whoever has it can open your payouts.", "neutral")
          : callout("<strong>Back up your keys now.</strong> They live only in this browser. If it is cleared, payouts can't be opened without the backup.", "", "flag")}
      </article>
      ${how}
    </section>`;
  }

  // ---------- Receive: Payouts ----------
  const live = {}; // stealth address -> { cngn, usdt } | { error }
  let picked = null;
  let showCashout = false;
  let scanning = null; // { done, total } while checking Celo for announcements
  let scanError = null;

  /** Look for payouts to this code in Celo's announcements. Only new blocks after the first time. */
  async function scanPayouts(force) {
    const keys = store.get("keys", null);
    if (!keys || !R || !R.scan || scanning) return;
    const prog = store.get("scan", {});
    const same = prog.meta === keys.metaAddress;
    if (!force && same && Date.now() - (prog.at || 0) < 30000) return;
    scanning = { done: 0, total: 0 };
    scanError = null;
    const redraw = () => route().page === "payouts" && !dirty && render();
    redraw();
    try {
      const out = await R.scan({
        rpcUrl: RPC,
        keys,
        from: same ? prog.to : null,
        onProgress: (done, total) => {
          scanning = { done, total };
          redraw();
        },
      });
      const list = store.get("payouts", []);
      const fresh = out.found.filter((f) => !list.some((p) => p.stealthAddress.toLowerCase() === f.stealthAddress.toLowerCase()));
      store.set("payouts", [...fresh, ...list]);
      store.set("scan", { meta: keys.metaAddress, to: out.scannedTo, at: Date.now() });
      if (fresh.length) {
        toast(`Found ${plural(fresh.length, "new payout", "new payouts")}`);
        refreshLive(fresh);
      }
    } catch (e) {
      scanError = e.shortMessage || e.message || "network error";
    }
    scanning = null;
    redraw();
  }

  function payouts() {
    const keys = store.get("keys", null);
    const list = store.get("payouts", []);
    const actions = `<button class="btn btn-secondary" type="button" id="cashout-toggle" aria-expanded="${showCashout}">${icon("info")}How to cash out</button>`;
    const cashout = showCashout
      ? `<section class="card stack" aria-label="How to cash out">
          <div class="card-head" style="margin-bottom:0"><h2>Cash out to your bank</h2><button class="btn btn-secondary btn-sm" type="button" id="cashout-close">Close</button></div>
          <ol class="checks">
            <li><span class="ico todo">1</span><div><div class="strong">Find an exchange that takes cNGN on Celo</div><div class="small muted">Nigerian exchanges such as Busha and Quidax list cNGN. In the exchange's app, check that its cNGN deposit network includes <strong>Celo</strong>.</div></div><span></span></li>
            <li><span class="ico todo">2</span><div><div class="strong">Move your naira there</div><div class="small muted">Copy the exchange's cNGN deposit address on Celo, paste it in <strong>Send to</strong> below, and click Move naira.</div></div><span></span></li>
            <li><span class="ico todo">3</span><div><div class="strong">Sell and withdraw</div><div class="small muted">On the exchange, sell the cNGN for naira (cNGN is backed 1:1 by naira), then withdraw to your bank account.</div></div><span></span></li>
          </ol>
          ${callout("Only send to a cNGN deposit address on the <strong>Celo</strong> network. If the exchange only lists other networks, don't send there: money sent on a network it doesn't support may not arrive.", "", "flag")}
        </section>`
      : "";
    if (!keys) {
      return `${head({ title: "Payouts", lede: "Payouts to your code show up here by themselves. Only your keys can recognise them.", actions })}
      ${cashout}
      <section class="card">${empty("code", `<p>Create your receiving code first. Payouts can only be opened with the keys behind it.</p><a class="btn btn-primary btn-sm" href="#/get/code">Create my receiving code</a>`)}</section>`;
    }
    const state = (p) => {
      const l = live[p.stealthAddress];
      if (!l) return "checking";
      if (l.error) return "unknown";
      return l.cngn > 0 ? "ready" : p.movedTx ? "moved" : "empty";
    };
    const label = { checking: "Checking…", unknown: "Couldn't check", ready: "Ready to move", moved: "Moved", empty: "Empty" };
    // Anyone can announce a payout with any amount, so show what is really at the address once it's checked.
    // A payout moved from this browser keeps the amount that was in it.
    const shownNgn = (p) => {
      const l = live[p.stealthAddress];
      return l && !l.error && !(p.movedTx && l.cngn === 0) ? l.cngn : p.amountNgn;
    };
    const ready = list.filter((p) => state(p) === "ready");
    const readyNgn = ready.reduce((a, p) => a + live[p.stealthAddress].cngn, 0);
    if (!picked || !list.some((p) => p.stealthAddress === picked)) picked = (ready[0] || list[0] || {}).stealthAddress || null;
    const sel = list.find((p) => p.stealthAddress === picked);
    const selLive = sel && live[sel.stealthAddress];
    const gas = (list.find((p) => p.gasMoneyUsdt) || {}).gasMoneyUsdt || 0.05;
    const prog = store.get("scan", {});
    const scanNote = scanning
      ? `<span class="small muted">${scanning.total ? `Checking Celo… ${Math.round((scanning.done / scanning.total) * 100)}%` : "Checking Celo…"}</span>`
      : scanError
        ? `<span class="small muted">Couldn't check Celo</span>`
        : prog.meta === keys.metaAddress && prog.at
          ? `<span class="small muted">Checked ${ago(prog.at)}</span>`
          : "";

    return `${head({ title: "Payouts", lede: "Payouts to your code show up here by themselves. Only your keys can recognise them.", actions })}
    ${cashout}
    <section class="grid-3" aria-label="Summary">
      <article class="card stat"><span class="label">Ready to move</span><span class="figure">${ngn(readyNgn)}</span><span class="note">${badge(plural(ready.length, "payout", "payouts"))}</span></article>
      <article class="card stat"><span class="label">Received in total</span><span class="figure">${ngn(list.reduce((a, p) => a + p.amountNgn, 0))}</span><span class="note">${plural(list.length, "payout", "payouts")}, each to its own address</span></article>
      <article class="card stat"><span class="label">Gas money included</span><span class="figure">${usdt(gas)}<span class="unit">USD₮</span></span><span class="note">per payout, so moving it costs you nothing</span></article>
    </section>
    <section class="grid-wide" aria-label="Payouts">
      <article class="card">
        <div class="card-head"><h2>Your payouts</h2><div class="row">${scanNote}<button class="btn btn-secondary btn-sm" type="button" id="scan-now" ${scanning ? "disabled" : ""}>${icon("refresh")}Check again</button></div></div>
        ${list.length ? `<div class="table-wrap"><table class="payouts-table">
          <thead><tr><th>Invoice</th><th class="hide-sm">Date</th><th class="hide-sm">Address</th><th>Amount</th></tr></thead>
          <tbody>${list.map((p) => `<tr class="pick ${p.stealthAddress === picked ? "picked" : ""}" data-pick="${esc(p.stealthAddress)}" tabindex="0" aria-selected="${p.stealthAddress === picked}">
            <td><span class="strong mono">${esc(p.invoiceId)}</span><span class="sub">${label[state(p)]}</span></td>
            <td class="hide-sm"><time>${p.paidAt ? fmtDate(p.paidAt) : "–"}</time></td>
            <td class="hide-sm mono small">${esc(short(p.stealthAddress))}</td>
            <td class="mono">${ngn(shownNgn(p))}</td>
          </tr>`).join("")}</tbody>
        </table></div>` : scanning ? loading("Looking for your payouts on Celo…") : empty("inbox", "<p>No payouts yet. When a client pays your code, it shows up here by itself.</p>")}
        <p class="small muted" style="margin-top:12px">Got a receipt file from a client? <button class="btn-link" type="button" id="open-receipt">Open it</button></p>
      </article>
      <article class="card stack">
        ${sel ? `<div class="card-head" style="margin-bottom:0"><h2>Move ${ngn(selLive && !selLive.error ? selLive.cngn : sel.amountNgn)}</h2>${badge(sel.invoiceId)}</div>
          ${state(sel) === "ready" ? `
          <div class="field"><label for="to">Send to</label><input class="input mono" id="to" autocomplete="off" spellcheck="false" placeholder="0x… wallet address"></div>
          <button class="btn btn-primary" type="button" id="move">${icon("send")}Move naira</button>
          <p class="small muted">Your wallet, or an exchange that takes cNGN on Celo. Gas comes from the ${usdt(selLive && !selLive.error && selLive.usdt ? selLive.usdt : sel.gasMoneyUsdt)} USD₮ sent with this payout.</p>`
          : state(sel) === "moved" ? `<p>Moved. <a href="${esc(R.explorerTx(sel.movedTx))}" target="_blank" rel="noopener">See the transaction</a></p>`
          : state(sel) === "checking" ? loading("Checking the payout address…")
          : state(sel) === "unknown" ? `<p class="muted">Couldn't reach Celo to check this payout: ${esc(selLive.error)}</p><div><button class="btn btn-secondary btn-sm" type="button" id="recheck-live">Try again</button></div>`
          : `<p class="muted">This payout address holds no naira.</p>`}`
        : `<div class="card-head" style="margin-bottom:0"><h2>Move naira</h2></div><p class="muted">Open a receipt to move a payout.</p>`}
      </article>
    </section>`;
  }

  async function refreshLive(list) {
    await Promise.all(
      list.map(async (p) => {
        try {
          live[p.stealthAddress] = await R.balances(RPC, p.stealthAddress);
        } catch (e) {
          live[p.stealthAddress] = { error: e.shortMessage || e.message || "network error" };
        }
      }),
    );
    if (route().page === "payouts" && !dirty) render();
  }

  // ---------- Guide (one walkthrough per side) ----------
  const GUIDES = window.NR_GUIDES || { pay: { steps: [] }, get: { steps: [] } };

  function guide() {
    const { mode, step } = route();
    const g = GUIDES[mode];
    if (!g.steps.length) return `${head({ title: "Guide" })}<section class="card">${callout("The guide didn't load. Reload the page.", "", "flag")}</section>`;
    const i = step - 1;
    const s = g.steps[i];
    const base = `#/${mode}/guide/`;
    const last = i === g.steps.length - 1;
    return `${head({ title: g.title, lede: g.lede })}
    <nav class="guide-steps" aria-label="Steps">${g.steps
      .map((x, k) => `<a href="${base}${k + 1}" title="${esc(x.title)}" aria-label="Step ${k + 1}: ${esc(x.title)}" ${k === i ? 'aria-current="step"' : ""}>${k + 1}</a>`)
      .join("")}</nav>
    <section class="card guide-card ${s.wide ? "wide" : ""}" aria-label="Step ${step}: ${esc(s.title)}">
      <figure class="guide-shot">
        <a href="guide/${esc(s.img)}" target="_blank" rel="noopener" title="Open the picture full size"><img src="guide/${esc(s.img)}" srcset="guide/${esc(s.img)} 1.5x" alt="${esc(s.alt)}"></a>
        <figcaption>${s.plain ? "" : "The outlined button is the one to press. "}Click the picture to see it bigger.</figcaption>
      </figure>
      <div class="guide-text stack">
        <span class="small muted">Step ${step} of ${g.steps.length}</span>
        <h2>${esc(s.title)}</h2>
        <p>${s.intro}</p>
        <ol class="guide-list">${s.steps.map((x) => `<li>${x}</li>`).join("")}</ol>
        ${s.tip ? callout(s.tip, "neutral") : ""}
        <div class="row guide-nav">
          ${i > 0 ? `<a class="btn btn-secondary" href="${base}${step - 1}">Back</a>` : ""}
          ${last ? `<a class="btn btn-primary" href="#/${mode}/${MENUS[mode][0][0]}">Done</a>` : `<a class="btn btn-primary" href="${base}${step + 1}">Next: ${esc(g.steps[i + 1].title)}</a>`}
        </div>
      </div>
    </section>`;
  }

  // ---------- router ----------
  const MENUS = {
    pay: [["overview", "Overview", "home"], ["invoice", "Pay an invoice", "invoice"], ["freelancers", "Freelancers", "people"], ["access", "Agent access", "key"]],
    get: [["payouts", "Payouts", "inbox"], ["code", "Receiving code", "code"]],
  };
  const VIEWS = { pay: { overview, invoice: payInvoice, freelancers, access, guide }, get: { code, payouts, guide } };

  function route() {
    const [, mode = "pay", page, sub] = (location.hash || "#/pay/overview").split("/");
    const m = VIEWS[mode] ? mode : "pay";
    const p = VIEWS[m][page] ? page : MENUS[m][0][0];
    const n = (GUIDES[m] && GUIDES[m].steps.length) || 1;
    const step = Math.min(n, Math.max(1, parseInt(sub, 10) || 1));
    return { mode: m, page: p, step };
  }

  function renderSide(m) {
    if (m === "get") {
      const keys = store.get("keys", null);
      sideCard.innerHTML = keys
        ? `<span class="label">Your receiving code</span><span class="mono small clip">${esc(keys.metaAddress)}</span><a class="small" href="#/get/code">Copy or back up</a>`
        : `<span class="label">Your receiving code</span><span class="strong">Not created yet</span><a class="small" href="#/get/code">Create one</a>`;
      return;
    }
    const ses = activeSession();
    const st = HOSTED ? sendStatus() : null;
    if (HOSTED && st !== "unlocked") {
      sideCard.innerHTML = `<span class="label">Agent</span><span class="strong">${st === "locked" ? "Locked" : st === "none" ? "Not set up here" : "Loading…"}</span>`;
      return;
    }
    if (!S) sideCard.innerHTML = `<span class="label">Agent</span><span class="strong">${(CFG.agent || HOSTED) && !stateError ? "Connecting…" : "Not running"}</span>`;
    else if (!ses) sideCard.innerHTML = `<span class="label">Agent key</span><span class="strong">${S.session && S.session.expired ? "Expired" : "Not given yet"}</span><a class="small" href="#/pay/access">Agent access</a>`;
    else {
      const days = Math.max(0, Math.ceil((ses.expiresAt - Date.now()) / 86400000));
      sideCard.innerHTML = `<span class="label">Agent key</span><span class="spread"><span class="strong">Active</span>${badge(plural(days, "day", "days"))}</span><div class="bar"><span style="width:${pct(ses.used.usdt, ses.usdtPerWeek)}%"></span></div><span class="small muted mono">${usdt(Math.max(0, ses.usdtPerWeek - ses.used.usdt))} of ${limit(ses.usdtPerWeek)} USD₮ left</span>`;
    }
  }

  function render() {
    const { mode: m, page: p } = route();
    document.querySelectorAll(".mode a").forEach((a) => a.setAttribute("aria-current", String(a.dataset.mode === m)));
    menu.innerHTML = MENUS[m].map(([id, label, ic]) => `<li><a href="#/${m}/${id}" ${id === p ? 'aria-current="page"' : ""}>${icon(ic)}${label}</a></li>`).join("");
    renderSide(m);
    const guideLink = document.getElementById("guide-link");
    guideLink.href = `#/${m}/guide`;
    if (p === "guide") guideLink.setAttribute("aria-current", "page");
    else guideLink.removeAttribute("aria-current");
    const title = p === "guide" ? GUIDES[m].title || "Guide" : MENUS[m].find((x) => x[0] === p)[1];
    if (p === "guide") {
      // The guides need neither the agent nor the keys.
      view.innerHTML = guide();
    } else if (m === "pay" && !S) {
      view.innerHTML = HOSTED ? sendSetup(title) : CFG.agent && !stateError ? `${head({ title })}${loading("Asking the agent…")}` : agentMissing(title);
    } else if (m === "get" && !R) {
      view.innerHTML = `${head({ title })}<section class="card">${callout("This page's Receive code didn't load. Reload the page.", "", "flag")}</section>`;
    } else {
      view.innerHTML = VIEWS[m][p]();
    }
    document.title = `${title} · Naira Reach`;
    document.getElementById("sidebar").classList.remove("open");
    dirty = false;
  }

  async function go() {
    const { mode, page } = route();
    // A finished payment is cleared when you leave the page; a check in progress is kept.
    if (page !== "invoice" && INV && INV.result && !INV.paying) INV = null;
    if (page !== "freelancers") addOpen = false;
    // Locked elsewhere (another tab, or removed): don't keep showing what was on screen.
    if (HOSTED && window.NRSend && sendStatus() !== "unlocked") S = null;
    render();
    if (mode === "pay" && HOSTED && !window.NRSend) {
      await loadSend().then(() => (sendLoadError = null), (e) => (sendLoadError = e.message));
      render();
    }
    if (mode === "pay" && (CFG.agent || sendStatus() === "unlocked") && (!S || Date.now() - SAt > 15000)) {
      if (page === "guide" && S) return;
      await loadState();
      if (!dirty) render();
    }
    if (mode === "get" && page === "payouts" && R) {
      refreshLive(store.get("payouts", []));
      scanPayouts(false);
    }
  }

  // ---------- events ----------
  view.addEventListener("change", (e) => {
    if (e.target.id === "forget-ok") view.querySelector("#forget").disabled = !e.target.checked;
  });

  view.addEventListener("input", (e) => {
    dirty = true;
    if (e.target.id === "override") {
      INV.override = e.target.checked;
      const btn = view.querySelector("#pay");
      if (btn) btn.disabled = !INV.override;
    }
  });

  view.addEventListener("click", async (e) => {
    const t = e.target.closest("button, tr[data-pick]");
    if (!t) return;
    if (t.dataset.copy) return copy(t.dataset.copy, t.dataset.what || "Text");
    if (t.dataset.receipt) return downloadReceipt(t.dataset.receipt, t.dataset.invoice);
    if (t.dataset.pick) {
      picked = t.dataset.pick;
      return render();
    }
    if (t.dataset.remove) {
      if (!window.confirm(`Remove ${t.dataset.name} from your list? The agent will hold their invoices until you add them again.`)) return;
      await busy(t, "Removing", () => api("DELETE", `/freelancers/${encodeURIComponent(t.dataset.remove)}`)).catch(() => {});
      await loadState();
      return render();
    }
    switch (t.id) {
      case "delivery-setup":
        return busy(t, "Working", async () => {
          const r = await api("POST", "/delivery/setup", {});
          toast(r.announced ? `Delivered ${plural(r.announced, "payout", "payouts")}. Freelancers will see them on Receive.` : "Automatic delivery is on");
          await loadState();
          render();
        }).catch(() => {});
      case "retry":
        await loadState();
        return render();
      case "import-pick": {
        const file = await pickFile(".json,application/json");
        if (!file) return;
        importFile = file;
        const name = view.querySelector("#import-name");
        if (name) name.textContent = file.name;
        return;
      }
      case "forget":
        if (!window.confirm("Remove the agent from this browser? Without its locked file and password it can't be brought back.")) return;
        window.NRSend.forget();
        S = null;
        toast("Removed from this browser");
        return render();
      case "backup-send":
        return busy(t, "Preparing", async () => {
          const text = await window.NRSend.backup();
          download("naira-reach-agent-locked.json", JSON.parse(text));
          toast("Locked backup downloaded. Keep it with your password.");
        }).catch(() => {});
      case "lock-send":
        await window.NRSend.lock();
        S = null;
        toast("Send is locked");
        return render();
      case "choose":
        return uploadInvoice(await pickFile(".json,.txt,.md,application/json,text/plain"));
      case "clear":
        INV = null;
        return render();
      case "pay":
        return payNow();
      case "recheck":
        return busy(t, "Checking", async () => {
          INV.review = await api("POST", "/invoices", { name: INV.fileName, data: lastInvoiceData });
          INV.result = null;
          INV.override = false;
          render();
        }).catch(() => {});
      case "to-add":
        addOpen = true;
        render();
        return document.getElementById("f-name").focus();
      case "f-cancel":
        addOpen = false;
        return render();
      case "activate":
        return busy(t, "Activating… about a minute", async () => {
          await api("POST", "/wallet/setup");
          toast("Wallet activated");
          await loadState();
          render();
        }).catch(() => {});
      case "revoke":
        if (!window.confirm("Take the agent's key back now? It stops working in the next block.")) return;
        return busy(t, "Revoking", async () => {
          await api("POST", "/session/revoke");
          toast("The agent's key is revoked");
          await loadState();
          render();
        }).catch(() => {});
      case "proof":
        return busy(t, "Signing", async () => {
          await api("POST", "/proof/refresh");
          toast("Textile proof signed for 11 hours");
          await loadState();
          render();
        }).catch(() => {});
      case "make-keys":
        store.set("keys", R.newKeys());
        store.set("backedUp", false);
        toast("Your receiving code is ready. Back it up next.");
        return render();
      case "restore": {
        const file = await pickFile(".json,application/json");
        if (!file) return;
        try {
          store.set("keys", R.checkKeys(JSON.parse(await readText(file))));
          store.set("backedUp", true);
          toast("Keys restored");
        } catch (err) {
          toast(err instanceof SyntaxError ? "That file is not a key backup." : err.message);
        }
        return render();
      }
      case "backup":
        download("naira-reach-receiving-keys.json", { note: "Naira Reach receiving keys. Private: whoever has this file can open your payouts.", ...store.get("keys", {}) });
        store.set("backedUp", true);
        return render();
      case "open-receipt": {
        const file = await pickFile(".json,application/json");
        if (!file) return;
        try {
          const opened = R.openReceipt(JSON.parse(await readText(file)), store.get("keys", null));
          const list = store.get("payouts", []).filter((p) => p.stealthAddress !== opened.stealthAddress);
          store.set("payouts", [opened, ...list]);
          picked = opened.stealthAddress;
          delete live[opened.stealthAddress];
          toast(`${opened.invoiceId}: ${ngn(opened.amountNgn)} is yours`);
          render();
          refreshLive([opened]);
        } catch (err) {
          toast(err instanceof SyntaxError ? "That file is not a receipt." : err.message);
        }
        return;
      }
      case "cashout-toggle":
      case "cashout-close":
        showCashout = t.id === "cashout-toggle" ? !showCashout : false;
        return render();
      case "scan-now":
        return scanPayouts(true);
      case "recheck-live":
        delete live[picked];
        render();
        return refreshLive(store.get("payouts", []).filter((p) => p.stealthAddress === picked));
      case "move": {
        const to = view.querySelector("#to").value.trim();
        const list = store.get("payouts", []);
        const p = list.find((x) => x.stealthAddress === picked);
        if (!p) return;
        return busy(t, "Moving… about 10 seconds", async () => {
          const r = await R.move({ rpcUrl: RPC, keys: store.get("keys", null), payout: p, to, code: CFG.attributionCode });
          p.movedTx = r.hash;
          p.movedTo = r.to;
          store.set("payouts", list);
          toast(`Moved ${ngn(r.amountNgn)} to ${short(r.to)}`);
          delete live[p.stealthAddress];
          render();
          refreshLive([p]);
        }).catch(() => {});
      }
    }
  });

  view.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form).entries());
    if (form.id === "f-form") {
      await busy(form.querySelector("#f-save"), "Saving", async () => {
        await api("POST", "/freelancers", data);
        addOpen = false;
        toast(`${data.name} is on your list`);
        await loadState();
        render();
      }).catch(() => {});
    }
    if (form.id === "unlock-form") {
      await busy(form.querySelector("#u-go"), "Unlocking", async () => {
        await (await loadSend()).unlock(data.password);
        form.reset();
        await loadState();
        render();
      }).catch(() => {});
    }
    if (form.id === "import-form") {
      await busy(form.querySelector("#i-go"), "Opening", async () => {
        if (!importFile) throw new Error("Choose the locked file first.");
        await (await loadSend()).importFile(await readText(importFile), data.password);
        importFile = null;
        toast("Your agent is in this browser");
        await loadState();
        render();
      }).catch(() => {});
    }
    if (form.id === "new-form") {
      await busy(form.querySelector("#n-go"), "Creating", async () => {
        if (data.password !== data.repeat) throw new Error("The two passwords don't match.");
        await (await loadSend()).create(data.password, data.clientName);
        toast("Your wallet is ready. Download the locked backup from Agent access.");
        await loadState();
        render();
      }).catch(() => {});
    }
    if (form.id === "export-form") {
      await busy(form.querySelector("#x-go"), "Locking", async () => {
        const sealed = await api("POST", "/export", data);
        download("naira-reach-agent-locked.json", sealed);
        form.reset();
        toast("Locked file downloaded. Open it on the online site with the same password.");
      }).catch(() => {});
    }
    if (form.id === "g-form") {
      await busy(form.querySelector("#g-save"), "Granting… about a minute", async () => {
        await api("POST", "/session/grant", data);
        toast("The agent has its key");
        await loadState();
        render();
      }).catch(() => {});
    }
  });

  // Drag and drop an invoice.
  view.addEventListener("dragover", (e) => {
    const d = e.target.closest && e.target.closest("#drop");
    if (!d) return;
    e.preventDefault();
    d.classList.add("over");
  });
  view.addEventListener("dragleave", (e) => {
    const d = e.target.closest && e.target.closest("#drop");
    if (d) d.classList.remove("over");
  });
  view.addEventListener("drop", (e) => {
    const d = e.target.closest && e.target.closest("#drop");
    if (!d) return;
    e.preventDefault();
    uploadInvoice(e.dataTransfer.files[0]);
  });
  view.addEventListener("keydown", (e) => {
    const row = e.target.closest && e.target.closest("tr[data-pick]");
    if (row && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      row.click();
    }
  });

  window.addEventListener("hashchange", () => {
    go();
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });
  document.getElementById("menu-toggle").addEventListener("click", (e) => {
    const sb = document.getElementById("sidebar");
    const open = sb.classList.toggle("open");
    e.currentTarget.setAttribute("aria-expanded", String(open));
  });
  if (!location.hash) location.replace("#/pay/overview");
  go();
})();
