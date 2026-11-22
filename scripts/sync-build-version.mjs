// Propagates the version from package.json (the single source of truth) into
// every file that has to repeat it, then prints it for the build script.
//
// This deliberately does NOT bump anything. release.py picks the version and
// writes the matching release-notes/v<version>.json; if the build bumped on top
// of that, the installer and the notes would describe different releases - and
// a build that quietly lands on the version users already have ships an update
// nobody can install, because version_is_newer() rejects an equal version.
import { readFileSync, writeFileSync } from "node:fs";

const packagePath = "package.json";
const tauriPath = "src-tauri/tauri.conf.json";
const tauriMacosPath = "src-tauri/tauri.macos.conf.json";
const cargoPath = "src-tauri/Cargo.toml";
const landingPath = "fetchr-landing.html";

const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const version = String(packageJson.version || "").trim();

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`package.json version is not X.Y.Z: "${version}"`);
  process.exit(1);
}

const tauriConfig = JSON.parse(readFileSync(tauriPath, "utf8"));
tauriConfig.version = version;
if (tauriConfig.app?.windows?.[0]?.title) {
  tauriConfig.app.windows[0].title = `Fetchr beta v${version}`;
}
writeFileSync(tauriPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);

updateOptional(tauriMacosPath, (raw) => {
  const config = JSON.parse(raw);
  if (config.app?.windows?.[0]?.title) {
    config.app.windows[0].title = `Fetchr beta v${version}`;
  }
  return `${JSON.stringify(config, null, 2)}\n`;
});

const cargoToml = readFileSync(cargoPath, "utf8");
const cargoUpdated = cargoToml.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
if (cargoUpdated === cargoToml && !cargoToml.includes(`version = "${version}"`)) {
  console.error(`Could not set the [package] version in ${cargoPath}`);
  process.exit(1);
}
writeFileSync(cargoPath, cargoUpdated);

updateOptional(landingPath, (raw) =>
  raw.replace(
    /\/api\/downloads\/Fetchr-Setup-v\d+\.\d+\.\d+\.exe/g,
    `/api/downloads/Fetchr-Setup-v${version}.exe`,
  ),
);

// Visual version is injected at build time via Vite define (__APP_VERSION__).
console.log(version);

function updateOptional(path, transform) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  writeFileSync(path, transform(raw));
}
