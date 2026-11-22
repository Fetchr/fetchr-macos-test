/** Robokassa callbacks on the API server (https://fetchr.fun/api/robokassa/…).
 *
 * - result  (ResultURL): signed with Password#2. A valid call is appended to
 *   robokassa-payments.jsonl, which the bot polls to confirm the order, without
 *   the buyer's e-mail (Robokassa sends the receipt itself), and answered `OK<InvId>` so Robokassa stops retrying. Duplicates are expected
 *   and harmless: the bot finalizes an order once.
 * - success / fail (SuccessURL, FailURL): the buyer's browser lands here after
 *   paying; both send them back to the bot, where the order status lives.
 */

import { appendFile } from "node:fs/promises";

import { createRobokassa } from "./bot/robokassa.mjs";

const MAX_BODY = 16 * 1024;

async function readForm(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error("request body too large");
  }
  return new URLSearchParams(body);
}

export function createRobokassaResult({ login, password1, password2, test, paymentsPath, botUrl, now = () => Date.now(), log }) {
  const kassa = createRobokassa({ login, password1, password2, test });

  function text(res, status, body) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  }

  return {
    /** true when the request was ours. */
    async handle(req, res, url) {
      if (!url.pathname.startsWith("/robokassa/")) return false;
      const action = url.pathname.slice("/robokassa/".length);

      if (action === "success" || action === "fail") {
        res.writeHead(302, { Location: botUrl, "Cache-Control": "no-store" });
        res.end();
        return true;
      }
      if (action !== "result" || !["GET", "POST"].includes(req.method)) {
        text(res, 404, "not found");
        return true;
      }
      if (!kassa) {
        text(res, 503, "robokassa is not configured");
        return true;
      }

      const fields = req.method === "POST" ? await readForm(req) : url.searchParams;
      const payment = kassa.verifyResult(fields);
      if (!payment) {
        log(`Robokassa result rejected: bad signature for InvId ${fields.get("InvId") || "?"}`);
        text(res, 400, "bad sign");
        return true;
      }
      await appendFile(
        paymentsPath,
        `${JSON.stringify({
          inv_id: payment.invId,
          order_id: payment.shp.order || null,
          out_sum: payment.outSum,
          status: "paid",
          received_at: new Date(now()).toISOString(),
        })}\n`,
        "utf8",
      );
      text(res, 200, `OK${payment.invId}`);
      return true;
    },
  };
}
