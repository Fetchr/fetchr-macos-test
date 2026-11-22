/** Reporter ids in job logs and error reports only group occurrences, so they
 *  are stored as an HMAC under a secret kept outside the data dir: a leaked
 *  log cannot be matched against machine_id in the license file.
 *
 *  Without a secret the key lives only as long as the process: grouping breaks
 *  at each restart, but nothing linkable is ever written. */

import { createHmac, randomBytes } from "node:crypto";

export function createPseudonymizer({ secret = "", log = () => {} } = {}) {
  if (!secret) log("privacy: FETCHR_REPORTER_HMAC_SECRET is not set, reporter ids change at each restart");
  const key = secret || randomBytes(32);
  return (id) => createHmac("sha256", key).update(String(id)).digest("hex").slice(0, 32).toUpperCase();
}
