/** Robokassa: payment links for ruble orders and the ResultURL check.
 *
 * The bot builds the link; Robokassa calls ResultURL on the API server
 * (vps-api-server.mjs), which verifies the signature and appends the payment
 * to a JSONL file the bot polls. Neither process needs the other running.
 *
 * Every link carries a Receipt, so Robokassa's own «Робочеки» can file the
 * self-employed receipt in «Мой налог» without anyone doing it by hand.
 * Disabled until FETCHR_ROBOKASSA_LOGIN and both passwords are set.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const ROBOKASSA_PAY_URL = "https://auth.robokassa.ru/Merchant/Index.aspx";

const md5 = (value) => createHash("md5").update(value, "utf8").digest("hex");

/** Robokassa's Shp_ extras, sorted as its signature expects. */
function shpPart(shp) {
  return Object.keys(shp)
    .sort()
    .map((key) => `Shp_${key}=${shp[key]}`);
}

export function formatSum(amount) {
  return (Math.round(Number(amount) * 100) / 100).toFixed(2);
}

/** One service line; `tax: "none"` because the seller pays НПД, not VAT. */
export function buildReceipt({ name, sum }) {
  return {
    items: [
      {
        name: String(name).slice(0, 128),
        quantity: 1,
        sum: Number(formatSum(sum)),
        payment_method: "full_payment",
        payment_object: "service",
        tax: "none",
      },
    ],
  };
}

export function createRobokassa({ login, password1, password2, test = false }) {
  if (!login || !password1 || !password2) return null;

  return {
    /** Link the buyer opens to pay. `invId` is a positive integer unique per shop. */
    paymentUrl({ invId, amount, description, receiptName, email = "", shp = {} }) {
      const outSum = formatSum(amount);
      const receipt = encodeURIComponent(JSON.stringify(buildReceipt({ name: receiptName || description, sum: amount })));
      const signature = md5([login, outSum, String(invId), receipt, password1, ...shpPart(shp)].join(":"));
      const params = new URLSearchParams({
        MerchantLogin: login,
        OutSum: outSum,
        InvId: String(invId),
        Description: String(description).slice(0, 100),
        Receipt: receipt,
        SignatureValue: signature,
        Culture: "ru",
        Encoding: "utf-8",
      });
      if (email) params.set("Email", email);
      for (const key of Object.keys(shp).sort()) params.set(`Shp_${key}`, String(shp[key]));
      if (test) params.set("IsTest", "1");
      return `${ROBOKASSA_PAY_URL}?${params}`;
    },

    /** ResultURL fields → { invId, outSum, shp } when the signature holds, else null. */
    verifyResult(fields) {
      const get = (key) => (typeof fields.get === "function" ? fields.get(key) : fields[key]);
      const outSum = get("OutSum");
      const invId = get("InvId");
      const received = String(get("SignatureValue") || "").toLowerCase();
      if (!outSum || !invId || !/^[a-f0-9]{32}$/.test(received)) return null;
      const keys = typeof fields.keys === "function" ? [...fields.keys()] : Object.keys(fields);
      const shp = Object.fromEntries(
        keys.filter((key) => key.startsWith("Shp_")).map((key) => [key.slice(4), String(get(key))]),
      );
      const expected = md5([outSum, invId, password2, ...shpPart(shp)].join(":"));
      const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(received));
      return ok ? { invId: Number(invId), outSum: Number(outSum), shp } : null;
    },
  };
}
