import assert from "node:assert/strict";
import { test } from "node:test";

import { addedLines, findSecrets, forbiddenPath } from "./secret-scan.mjs";

// Fixtures are assembled at run time so this file never trips the scanner itself.
const join = (...parts) => parts.join("");
const PEM = join("-----BEGIN ", "PRIVATE KEY-----");
const ED25519_DER = join("MC4CAQAw", "BQYDK2VwBCIEI", "Abc123Def456Ghi789");
const BOT_TOKEN = join("1234567890", ":AA", "F".repeat(33));
const PROXY = join("http://", "realuser:s3cretPass", "@203.0.113.7:8080");
const VLESS = join("vless://", "0f4c8a4e-9d7b-4c1e-8f2a-3b5d6e7f8a9b", "@example.org:443");

const rules = (lines) => findSecrets(lines.map((text, index) => ({ file: "x.txt", line: index + 1, text }))).map((hit) => hit.rule);

test("private keys are caught in PEM and in bare PKCS#8 base64", () => {
  assert.deepEqual(rules([PEM]), ["private-key"]);
  assert.deepEqual(rules([`const key = "${ED25519_DER}";`]), ["private-key"]);
});

test("Telegram bot tokens, proxy credentials and VLESS links are caught", () => {
  assert.deepEqual(rules([`TELEGRAM=${BOT_TOKEN}`]), ["telegram-bot-token"]);
  assert.deepEqual(rules([`set "X=${PROXY}"`]), ["url-credentials"]);
  assert.deepEqual(rules([VLESS]), ["vless-key"]);
});

test("known secret variables are caught only with a real value", () => {
  assert.deepEqual(rules([join("FETCHR_VPS_TOKEN", "=abcdef0123456789")]), ["secret-variable"]);
  assert.deepEqual(rules([join("ERRORS_ADMIN_TOKEN", ": 'Zx81kd92jsla0s'")]), ["secret-variable"]);
  assert.deepEqual(rules([
    join("FETCHR_VPS_TOKEN", "="),
    join("FETCHR_UPDATE_PRIVATE_KEY", "=${FETCHR_UPDATE_PRIVATE_KEY}"),
    join("const token = process.env.", "FETCHR_VPS_TOKEN;"),
    join("FETCHR_TWITCH_RESOLVER", "=<your proxy>"),
    join("FETCHR_LICENSE_PRIVATE_KEY", ": privateKey.export({ type: \"pkcs8\" }),"),
  ]), []);
  assert.deepEqual(rules([join("ERRORS_ADMIN_TOKEN", "=eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl")]), ["secret-variable"]);
});

test("documented placeholders and marked lines pass", () => {
  assert.deepEqual(rules(["# Format: http://user:pass@ip:port or socks5://user:pass@ip:port"]), []);
  assert.deepEqual(rules([`${PROXY} // secret-scan: allow`]), []);
});

test("findings never repeat the secret itself", () => {
  const [hit] = findSecrets([{ file: "a.env", line: 3, text: `TOKEN=${BOT_TOKEN}` }]);
  assert.equal(hit.file, "a.env");
  assert.equal(hit.line, 3);
  assert.equal(hit.preview.includes(BOT_TOKEN), false);
});

test("secret files are refused by name, examples are not", () => {
  for (const path of ["build.env", "build.env.bak", "keys/id_ed25519", "server.pem", "vps-recorder/token.txt", "master-key.txt", "vpn-keys.txt", "src-tauri/.cargo/config.toml", ".env.local"]) {
    assert.equal(forbiddenPath(path), true, path);
  }
  for (const path of ["build.env.example", "src-tauri/.cargo/config.toml.example", "src/token-utils.ts", ".env.example", "id_ed25519.pub"]) {
    assert.equal(forbiddenPath(path), false, path);
  }
});

test("only lines the commit adds are scanned, with their new line numbers", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,0 +2,2 @@",
    "+first",
    "+second",
    "@@ -10 +12 @@",
    "-removed",
    "+third",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
  ].join("\n");
  assert.deepEqual(addedLines(diff), [
    { file: "a.txt", line: 2, text: "first" },
    { file: "a.txt", line: 3, text: "second" },
    { file: "a.txt", line: 12, text: "third" },
  ]);
});
