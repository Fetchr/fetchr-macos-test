/** Secret scan for commits: the shapes of the credentials that already leaked
 *  through this repository (licence signing key, proxy credentials, VPS token,
 *  VLESS keys) and the files that must never be committed.
 *
 * Runs from .githooks/pre-commit via scripts/secret-scan.mjs. A reviewed false
 * positive passes with "secret-scan: allow" on the same line. Patterns that
 * would match their own source are split so this file stays clean. */

const ALLOW_MARKER = "secret-scan: allow";

const SECRET_VARIABLES = [
  "FETCHR_VPS_TOKEN",
  "FETCHR_TWITCH_RESOLVER",
  "FETCHR_UPDATE_PRIVATE_KEY",
  "FETCHR_LICENSE_PRIVATE_KEY",
  "FETCHR_ROBOKASSA_PASSWORD1",
  "FETCHR_ROBOKASSA_PASSWORD2",
  "FETCHR_CRYPTO_PAY_TOKEN",
  "ERRORS_ADMIN_TOKEN",
  "TELEGRAM_BOT_TOKEN",
];

/** Values that only point at a secret: shell/batch/template references, env
 *  lookups, a function call (`key.export(...)`). */
const REFERENCE = String.raw`[$<{%]|process\.|import\.meta|env[.:(!]|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(`;

const RULES = [
  { rule: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // PKCS#8 ed25519 private key, base64 without the PEM armour.
  { rule: "private-key", pattern: new RegExp(["MC4CAQAw", "BQYDK2Vw"].join("")) },
  { rule: "telegram-bot-token", pattern: /\b\d{8,10}:AA[\w-]{33}\b/ },
  // user:pass@ in a URL; the documented placeholder "user:pass@" is fine.
  { rule: "url-credentials", pattern: /\b(?:https?|socks[45]h?):\/\/(?!user:pass@)[^\s:@/"'`]+:[^\s@/"'`]+@/i },
  { rule: "vless-key", pattern: /\bvless:\/\/[0-9a-f]{8}-[0-9a-f]{4}-/i },
  {
    rule: "secret-variable",
    pattern: new RegExp(String.raw`\b(?:${SECRET_VARIABLES.join("|")})\s*[=:]\s*["']?(?!${REFERENCE})[^\s"'#]{8,}`),
  },
];

const FORBIDDEN_PATHS = [
  /(^|\/)build\.env(?!\.example$)(\..+)?$/,
  /(^|\/)\.env(?!\.example$)(\..+)?$/,
  /(^|\/)id_(?:rsa|ecdsa|ed25519)$/,
  /\.(?:pem|p12|pfx|key)$/i,
  /(^|\/)token\.txt$/,
  /(^|\/)master-key\.txt$/,
  /(^|\/)vpn-keys\.txt$/,
  /(^|\/)\.cargo\/config\.toml$/,
];

export function forbiddenPath(path) {
  const normalized = String(path).replaceAll("\\", "/");
  return FORBIDDEN_PATHS.some((pattern) => pattern.test(normalized));
}

const mask = (match) => `${match.slice(0, 6)}… (${match.length} chars)`;

/** [{ file, line, text }] -> [{ file, line, rule, preview }]; the preview never holds the secret. */
export function findSecrets(entries) {
  return entries
    .filter((entry) => !entry.text.includes(ALLOW_MARKER))
    .flatMap((entry) =>
      RULES.map(({ rule, pattern }) => ({ rule, match: entry.text.match(pattern) }))
        .filter(({ match }) => match)
        .map(({ rule, match }) => ({ file: entry.file, line: entry.line, rule, preview: mask(match[0]) })),
    );
}

/** Lines a `git diff -U0` adds, with their line numbers in the new file. */
export function addedLines(diff) {
  const result = [];
  let file = null;
  let line = 0;
  for (const raw of diff.split("\n")) {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (text.startsWith("diff --git ")) {
      file = null;
    } else if (text.startsWith("+++ ")) {
      file = text === "+++ /dev/null" ? null : text.slice(4).replace(/^b\//, "");
    } else if (text.startsWith("@@")) {
      line = Number(text.match(/\+(\d+)/)?.[1] || 0);
    } else if (file && text.startsWith("+")) {
      result.push({ file, line, text: text.slice(1) });
      line += 1;
    } else if (file && text.startsWith(" ")) {
      line += 1;
    }
  }
  return result;
}
