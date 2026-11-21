// Sample data so every screen can be previewed before it is wired to the agent.
// The live app replaces this with the agent's own state (ledger, session, receipts).
window.NR_SAMPLE = {
  client: {
    name: "Mia",
    wallet: "0xB2441B175d620A3Fd5CDef28fA1c6957e6224431",
    balanceUsdt: 312.4,
    rate: 1444.57,
    rateFee: 0.02,
  },
  session: {
    active: true,
    expiresAt: "2026-11-28T10:12:00Z",
    grantedAt: "2026-11-21T10:12:00Z",
    usdtPerWeek: 300,
    usdtUsed: 162.7,
    cngnPerWeek: 500000,
    cngnUsed: 235000,
    proofValidUntil: "2026-11-21T21:12:00Z",
    calls: [
      { what: "Approve USD₮ for the swap", detail: "USD₮ · approve(address,uint256)" },
      { what: "Swap on Textile FX", detail: "LimitOrderReactor · 0xa9AA…35b3" },
      { what: "Send cNGN to the freelancer", detail: "cNGN · transfer(address,uint256)" },
      { what: "Send gas money with each payout", detail: "USD₮ · transfer(address,uint256)" },
    ],
  },
  freelancers: [
    { id: "ada", name: "Ada Obi", role: "Writer", meta: "st:celo:0x02a1f3c9e4b7d8a6…9c3e", limit: 500000, paid: 3, total: 277500 },
    { id: "tunde", name: "Tunde Bakare", role: "Designer", meta: "st:celo:0x03be7d21a0c94f55…4a1d", limit: 300000, paid: 1, total: 85000 },
    { id: "chiamaka", name: "Chiamaka Eze", role: "Developer", meta: "st:celo:0x02f08c6e13b2d9a4…7b60", limit: 800000, paid: 0, total: 0 },
  ],
  payouts: [
    { who: "Ada Obi", invoice: "INV-2026-014", date: "2026-11-21", status: "Paid", ngn: 150000, usdt: 103.84, tx: "0x7c1e…a94d" },
    { who: "Tunde Bakare", invoice: "TB-0031", date: "2026-11-19", status: "Paid", ngn: 85000, usdt: 58.86, tx: "0x2b90…11fe" },
    { who: "Ada Obi", invoice: "INV-2026-013", date: "2026-11-14", status: "Paid", ngn: 85000, usdt: 59.12, tx: "0xd4a7…6c02" },
    { who: "“Ada O. Payments”", invoice: "INV-88812", date: "2026-11-13", status: "Held", ngn: 2000000, usdt: null, tx: null, reason: "Not on your approved list" },
    { who: "Ada Obi", invoice: "INV-2026-012", date: "2026-11-07", status: "Paid", ngn: 42500, usdt: 29.61, tx: "0x91f3…0b7a" },
  ],
  weekly: {
    labels: ["Oct 10", "Oct 17", "Oct 24", "Oct 31", "Nov 7", "Nov 14", "Nov 21"],
    ngn: [0, 60000, 42500, 120000, 42500, 85000, 235000],
    usdt: [0, 42, 29, 83, 30, 59, 163],
  },
  invoice: {
    file: "INV-2026-015.txt",
    invoiceId: "INV-2026-015",
    from: "Ada Obi",
    amountNgn: 150000,
    description: "Brand guidelines refresh and landing page copy",
    checks: [
      { ok: true, title: "Ada Obi is on your approved list", note: "Matched by name" },
      { ok: true, title: "Not paid before", note: "No invoice <span class=\"mono\">INV-2026-015</span>, and this file is new" },
      { ok: true, title: "Within Ada's limit", note: "<span class=\"mono\">₦150,000</span> of <span class=\"mono\">₦500,000</span>" },
      { ok: true, title: "Within your weekly limits", note: "Costs <span class=\"mono\">103.84</span> USD₮ of the <span class=\"mono\">137.30</span> left this week" },
      { ok: false, title: "Wallet address written on the invoice", note: "<span class=\"mono\">0x9999…9999</span> was ignored. Ada is paid at her private code only." },
    ],
    quote: { usdt: 103.84, fee: 0.02, rate: 1444.57, expiresIn: 28 },
    payoutAddress: "0x5E0c…f21B",
  },
  freelancer: {
    name: "Ada",
    code: "st:celo:0x02a1f3c9e4b7d8a6f0e2c41b9d77a53e8c1f046b2d9e3a7c5b8f1e04d6a2c93e03c7b19e8d4f2a60b5e3c91d7a8f4e2b06c5d39a1e7f84c2b6d0e9a3f5c71b8",
    payouts: [
      { from: "0xB244…4431", invoice: "INV-2026-014", date: "2026-11-21", ngn: 150000, address: "0x7aD3…c09E", state: "Ready to move" },
      { from: "0xB244…4431", invoice: "INV-2026-013", date: "2026-11-14", ngn: 85000, address: "0x1F6b…8E2a", state: "Moved" },
      { from: "0xB244…4431", invoice: "INV-2026-012", date: "2026-11-07", ngn: 42500, address: "0xC08e…34d1", state: "Moved" },
    ],
  },
};
