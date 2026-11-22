/** Payment-link redirect on the API server: GET https://fetchr.fun/api/pay/<token>.
 *
 * The bot's «Оплатить» button points here instead of straight at Robokassa,
 * so the bot can tell «opened the payment page» from «only looked at the plan
 * card» and remind only the former.
 *
 * - The token is random (≥128 bits, base64url) and stored on the order by the
 *   bot (`pay_token`). Nothing about the buyer is in the URL.
 * - The answer is a 302 to the `pay_url` recorded on that order, and only if
 *   it is a Robokassa payment page: there is no target parameter, so this is
 *   not an open redirect. Unknown, expired or settled orders go to the bot.
 * - Each redirect appends { order_id, at } to pay-clicks.jsonl, which the bot
 *   polls like robokassa-payments.jsonl. No IP, no user agent.
 * - Requests are rate-limited per address; the address is never written down.
 */

import { appendFile } from "node:fs/promises";

const TOKEN = /^\/pay\/([A-Za-z0-9_-]{22,64})$/;
/** Orders still waiting for payment (superseded: replaced by another term, still payable). */
const OPEN = new Set(["pending", "superseded"]);
/** Links older than this go to the bot instead of the payment page. */
export const PAY_LINK_TTL_MS = 7 * 24 * 3_600_000;
const ROBOKASSA_HOSTS = new Set(["auth.robokassa.ru", "auth.robokassa.kz"]);

/** Only https Robokassa payment pages are ever a redirect target. */
export function isPaymentPage(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && ROBOKASSA_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** The latest snapshot of the order holding `token`, or null. */
function orderByToken(orders, token) {
  const byId = new Map();
  for (const order of orders) if (order?.id != null) byId.set(order.id, { ...byId.get(order.id), ...order });
  for (const order of byId.values()) if (order.pay_token === token) return order;
  return null;
}

export function createPayRedirect({ readOrders, clicksPath, botUrl, allow, now = () => Date.now(), log = () => {} }) {
  function redirect(res, location) {
    res.writeHead(302, { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.end();
  }

  return {
    /** true when the request was ours. `ip` is used for the rate limit only. */
    async handle(req, res, url, ip) {
      if (!url.pathname.startsWith("/pay/")) return false;
      const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { ...headers, Allow: "GET, HEAD" });
        res.end("method not allowed");
        return true;
      }
      if (!allow(ip)) {
        res.writeHead(429, { ...headers, "Retry-After": "60" });
        res.end("too many requests");
        return true;
      }
      const token = TOKEN.exec(url.pathname)?.[1];
      let order = null;
      try {
        order = token ? orderByToken(await readOrders(), token) : null;
      } catch (err) {
        log(`pay redirect: orders unreadable: ${err instanceof Error ? err.message : err}`);
      }
      const fresh = order && now() - Date.parse(order.created_at) <= PAY_LINK_TTL_MS;
      if (!order || !fresh || !OPEN.has(order.status) || order.method !== "robokassa" || !isPaymentPage(order.pay_url)) {
        redirect(res, botUrl);
        return true;
      }
      if (req.method === "GET") {
        await appendFile(clicksPath, `${JSON.stringify({ order_id: order.id, at: new Date(now()).toISOString() })}\n`, "utf8").catch((err) =>
          log(`pay redirect: click not saved: ${err instanceof Error ? err.message : err}`),
        );
      }
      redirect(res, order.pay_url);
      return true;
    },
  };
}
