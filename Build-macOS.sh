#!/usr/bin/env bash
# Fetchr — локальная сборка / запуск на macOS (.app / .dmg или dev-режим).
# Запускать НА macOS:
#   ./Build-macOS.sh              # быстрая сборка под текущую архитектуру (x86_64 в VirtualBox или arm64)
#   ./Build-macOS.sh --universal  # universal .dmg (Apple Silicon + Intel)
#   ./Build-macOS.sh --dev        # запуск в режиме разработки (tauri dev)
set -euo pipefail
cd "$(dirname "$0")"

MODE="native"
for arg in "$@"; do
  case "$arg" in
    --universal) MODE="universal" ;;
    --dev)       MODE="dev" ;;
    -h|--help)
      echo "Usage: $0 [--universal | --dev]"
      exit 0
      ;;
    *)
      echo "Неизвестный аргумент: $arg" >&2
      exit 1
      ;;
  esac
done

ARCH="$(uname -m)"
echo "[Fetchr] macOS ($ARCH, mode=$MODE)"

# --- 1. Проверка окружения --------------------------------------------------
xcode-select -p >/dev/null 2>&1 || { echo "Нет Xcode CLT. Установи: xcode-select --install"; exit 1; }
command -v cargo >/dev/null || { echo "Нет Rust. Установи: https://rustup.rs (или ./Setup-macOS.sh)"; exit 1; }
command -v node  >/dev/null || { echo "Нет Node.js 20+. Установи: brew install node (или ./Setup-macOS.sh)"; exit 1; }
if ! command -v pnpm >/dev/null; then
  if command -v corepack >/dev/null; then
    corepack enable && corepack prepare pnpm@9 --activate
  else
    npm install -g pnpm@9
  fi
fi

if ! command -v ffmpeg >/dev/null; then
  echo "[!] ffmpeg не найден в PATH. Для работы Fetchr установи: brew install ffmpeg"
fi

if [ "$MODE" = "universal" ]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
fi

# --- 2. CLI-инструменты, которые бандлятся (mac-ресурсы) --------------------
# yt-dlp (universal) и N_m3u8DL-RE (под архитектуру хоста: osx-x64 или osx-arm64).
if [ ! -f yt-dlp ]; then
  echo "  качаю yt-dlp..."
  curl -fL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" -o yt-dlp
  chmod +x yt-dlp
fi

NM_TAG="osx-x64"
if [ "$ARCH" = "arm64" ] || [ "$MODE" = "universal" ]; then
  NM_TAG="osx-arm64"
fi

# Если файл уже лежит, но от другой архитектуры (например, скопирован с другой машины) — перекачаем.
if [ -f N_m3u8DL-RE ] && [ "$MODE" != "universal" ]; then
  if [ "$ARCH" = "x86_64" ] && file N_m3u8DL-RE | grep -q "arm64" && ! file N_m3u8DL-RE | grep -q "x86_64"; then
    echo "  N_m3u8DL-RE был для arm64, перекачиваю для x86_64..."
    rm -f N_m3u8DL-RE
  fi
fi

if [ ! -f N_m3u8DL-RE ]; then
  echo "  качаю N_m3u8DL-RE ($NM_TAG)..."
  tmp="$(mktemp -d)"
  url="$(curl -fsSL https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest \
        | grep -o "\"browser_download_url\": *\"[^\"]*${NM_TAG}[^\"]*\\.tar\\.gz\"" | head -n1 | cut -d'"' -f4)"
  if [ -z "$url" ]; then
    echo "Не удалось найти архив N_m3u8DL-RE для $NM_TAG" >&2
    exit 1
  fi
  curl -fL "$url" -o "$tmp/nm.tar.gz"
  tar -xf "$tmp/nm.tar.gz" -C "$tmp"
  cp "$(find "$tmp" -type f -name 'N_m3u8DL-RE' | head -n1)" ./N_m3u8DL-RE
  chmod +x N_m3u8DL-RE
  rm -rf "$tmp"
fi

# --- 3. Build-time конфиг ---------------------------------------------------
if [ -f build.env ]; then
  echo "  загружаю build.env..."
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ""|\#*) continue ;;
      *=*) export "$line" ;;
    esac
  done < build.env
fi

export FETCHR_UI_REDESIGN="${FETCHR_UI_REDESIGN:-true}"
export VITE_FETCHR_UI_REDESIGN="${VITE_FETCHR_UI_REDESIGN:-true}"
export FETCHR_VPS_API_URL="${FETCHR_VPS_API_URL:-https://fetchr.fun/api}"
export FETCHR_TG_BETA_BOT="${FETCHR_TG_BETA_BOT:-fetchr_beta_bot}"

# --- 4. Зависимости и сборка / запуск ---------------------------------------
pnpm install --no-frozen-lockfile

if [ "$MODE" = "dev" ]; then
  exec pnpm tauri dev
elif [ "$MODE" = "universal" ]; then
  pnpm tauri build --target universal-apple-darwin
  BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
else
  pnpm tauri build
  BUNDLE_DIR="src-tauri/target/release/bundle"
fi

echo
echo "[OK] Готово:"
ls -1 "$BUNDLE_DIR"/dmg/*.dmg 2>/dev/null || true
ls -1d "$BUNDLE_DIR"/macos/*.app 2>/dev/null || true

if [ -d "$BUNDLE_DIR/macos/Fetchr.app" ]; then
  xattr -dr com.apple.quarantine "$BUNDLE_DIR/macos/Fetchr.app" 2>/dev/null || true
  echo
  echo "Запустить сразу:  open \"$BUNDLE_DIR/macos/Fetchr.app\""
fi
echo "Если перенесёшь в /Applications и macOS ругнётся на подпись:"
echo "  xattr -dr com.apple.quarantine /Applications/Fetchr.app"
echo "Для работы нужен ffmpeg:  brew install ffmpeg"
