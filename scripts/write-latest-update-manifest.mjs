import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Must match UPDATE_SIGNATURE_CONTEXT and APP_CHANNEL in src-tauri/src/updater.rs
// and src-tauri/src/remote.rs.
const SIGNATURE_CONTEXT = "fetchr-update-v1";
const APP_CHANNEL = "beta";

const [, , version, installerPath] = process.argv;

if (!version || !installerPath) {
  throw new Error("Usage: node scripts/write-latest-update-manifest.mjs <version> <installer-path>");
}

const bytes = readFileSync(installerPath);
const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
const installerName = basename(installerPath).replaceAll("\\", "/");
const releaseNotesPath = join("release-notes", `v${version}.json`);
// Страницы окна «Что нового»: { "pages": { "ru": [{ category, title, items, media }], "en": [...] } }
const pagesI18n = existsSync(releaseNotesPath) ? (JSON.parse(readFileSync(releaseNotesPath, "utf8")).pages ?? null) : null;
const notesI18n = existsSync(releaseNotesPath)
  ? (() => {
      const saved = JSON.parse(readFileSync(releaseNotesPath, "utf8"));
      console.error(`Notes loaded from: ${releaseNotesPath}`);
      return { ru: saved.ru, en: saved.en || saved.ru };
    })()
  : {
      ru: [
        `Обновление Fetchr v${version} 🚀`,
        "- Исправлен запуск распознавания речи для пользователей с кириллицей в имени Windows-профиля",
        "- Исправлено определение файлов GigaAM в пользовательском каталоге",
        "- Убрано дублирование технической ошибки ASR в интерфейсе"
      ].join("\n"),
      en: [
        `Fetchr Update v${version} 🚀`,
        "- Fixed speech recognition for Windows profiles whose names contain non-ASCII characters",
        "- Fixed GigaAM model file detection in the per-user data directory",
        "- Removed duplicated ASR diagnostics from error messages"
      ].join("\n"),
    };
if (!existsSync(releaseNotesPath)) {
  console.error(`No ${releaseNotesPath} found, using fallback placeholder notes.`);
}

const installerUrl = `https://fetchr.fun/api/downloads/${installerName}`;

const manifest = {
  version,
  installer_url: installerUrl,
  installer_sha256: sha256,
  notes: notesI18n.ru,
  notes_i18n: notesI18n,
  ...(pagesI18n ? { pages_i18n: pagesI18n } : {}),
  published_at: new Date().toISOString(),
  signature: signManifest(version, installerUrl, sha256),
};

const manifestPath = join(dirname(installerPath), "latest-update.json");
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(sha256);

/**
 * Covers only the fields that decide what gets executed. Mirrors
 * `signed_payload()` in src-tauri/src/updater.rs — change both together.
 */
function signedPayload(releaseVersion, url, hash) {
  return [
    SIGNATURE_CONTEXT,
    APP_CHANNEL,
    releaseVersion.trim(),
    url.trim(),
    hash.trim().toLowerCase(),
  ].join("\n");
}

function signManifest(releaseVersion, url, hash) {
  const pem = process.env.FETCHR_UPDATE_PRIVATE_KEY;
  if (!pem) {
    throw new Error(
      "FETCHR_UPDATE_PRIVATE_KEY is required (PKCS#8 ed25519 PEM). Without it the manifest " +
        "would be unsigned and every client would refuse the update.",
    );
  }
  const privateKey = createPrivateKey(pem.includes("\\n") ? pem.replaceAll("\\n", "\n") : pem);
  const signature = sign(null, Buffer.from(signedPayload(releaseVersion, url, hash), "utf8"), privateKey);

  const publicKey = createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64");
  console.error(`Signed with public key: ${publicKey}`);
  console.error("This must equal FETCHR_UPDATE_PUBKEY in the shipped build, or clients reject it.");

  return signature.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
