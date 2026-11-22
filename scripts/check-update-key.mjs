#!/usr/bin/env node
// Confirms FETCHR_UPDATE_PRIVATE_KEY and FETCHR_UPDATE_PUBKEY are two halves of
// the same pair. Mismatched halves are the one release mistake that cannot be
// undone remotely: the installer ships with a public key that will reject every
// manifest the private key signs, so those users never receive another update.
import { createPrivateKey, createPublicKey } from "node:crypto";

const pubExpected = (process.env.FETCHR_UPDATE_PUBKEY || "").trim();
const pem = (process.env.FETCHR_UPDATE_PRIVATE_KEY || "").trim();

if (!pubExpected) fail("FETCHR_UPDATE_PUBKEY is not set.");
if (!pem) fail("FETCHR_UPDATE_PRIVATE_KEY is not set.");

let derived;
try {
  const privateKey = createPrivateKey(pem.includes("\\n") ? pem.replaceAll("\\n", "\n") : pem);
  derived = createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64");
} catch (error) {
  fail(`FETCHR_UPDATE_PRIVATE_KEY is not a valid PKCS#8 ed25519 key: ${error.message}`);
}

if (derived !== pubExpected) {
  fail(
    "The key halves do not match.\n" +
      `  FETCHR_UPDATE_PUBKEY : ${pubExpected}\n` +
      `  derived from private : ${derived}\n` +
      "Replace BOTH lines in build.env with one pair from scripts/make-update-key.mjs.",
  );
}

console.log(`update key pair OK (${derived.slice(0, 8)}...)`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
