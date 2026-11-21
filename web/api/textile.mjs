// Vercel function: passes the online Send side's Textile FX calls on to
// Textile's API, which doesn't answer browsers directly. It holds no keys and
// keeps nothing: the browser signs everything itself. Only the four calls
// Naira Reach makes, for USD₮ to cNGN on Celo, are passed on.
const TEXTILE = "https://api.textilecredit.com/v2";
const CELO = 42220;
const USDT = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
const CNGN = "0xf6829d7393dae24509eb1e52ee8e572e2e271a4f";
const MAX_BODY = 64 * 1024;

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** Which Textile call this is, and the method it must use. */
function callOf(p) {
  if (p === "rfq/request" || p === "rfq/preview") return { method: "POST", quote: true };
  if (/^rfq\/[A-Za-z0-9_-]{1,100}\/submit$/.test(p)) return { method: "POST", quote: false };
  if (/^rfq\/[A-Za-z0-9_-]{1,100}$/.test(p)) return { method: "GET", quote: false };
  return null;
}

export async function handle(request, upstream = fetch) {
  const url = new URL(request.url);
  const p = url.searchParams.get("p") || "";
  const call = callOf(p);
  if (!call) return json(404, { error: "Not a Textile call this site makes." });
  if (request.method !== call.method) return json(405, { error: "Not allowed." });
  // Browsers say where a request comes from; only this site's own pages may use it.
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return json(403, { error: "Requests from other websites are refused." });

  let body;
  if (call.method === "POST") {
    body = await request.text();
    if (body.length > MAX_BODY) return json(413, { error: "Too large." });
    if (call.quote) {
      let q;
      try {
        q = JSON.parse(body);
      } catch {
        return json(400, { error: "Couldn't read that request." });
      }
      const same = (a, b) => typeof a === "string" && a.toLowerCase() === b;
      if (q?.chainId !== CELO || !same(q.sellToken, USDT) || !same(q.buyToken, CNGN)) {
        return json(400, { error: "Only USD₮ to cNGN quotes on Celo go through here." });
      }
    }
  }

  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const claim = request.headers.get("x-rfq-claim");
  if (claim) headers["x-rfq-claim"] = claim.slice(0, 4096);

  try {
    const res = await upstream(`${TEXTILE}/${p}`, { method: call.method, headers, body, signal: AbortSignal.timeout(80_000) });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") || "application/json", "cache-control": "no-store" },
    });
  } catch {
    return json(502, { error: "Textile didn't answer in time. Try again." });
  }
}

export default { fetch: (request) => handle(request) };
