#!/usr/bin/env node
// Generates the release signing key pair for update manifests and prints both
// halves already formatted as build.env lines (the PEM folded onto one line
// with \n escapes, which is what the line-based build.env parser needs).
//
// Run once, ever. Rotating the pair later strands every installed build: they
// carry the old public key and will reject manifests signed with the new one.
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).trim().replaceAll("\n", "\\n");

console.log("# --- paste into build.env, then keep the private line in a password manager ---");
console.log(`FETCHR_UPDATE_PUBKEY=${pub}`);
console.log(`FETCHR_UPDATE_PRIVATE_KEY=${pem}`);
