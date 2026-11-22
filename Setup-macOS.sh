#!/usr/bin/env bash
# Первичная настройка окружения на чистой macOS (включая VirtualBox) для сборки и теста Fetchr.
set -euo pipefail
cd "$(dirname "$0")"

echo "[Fetchr] Настройка окружения macOS ($(uname -m))"

# 1. Xcode Command Line Tools
if ! xcode-select -p >/dev/null 2>&1; then
  echo "-> Устанавливаю Xcode Command Line Tools (подтверди окно, если появится)..."
  xcode-select --install || true
  echo "После завершения установки Xcode CLT запусти этот скрипт повторно."
  exit 0
fi
echo "[OK] Xcode CLT"

# 2. Homebrew
if ! command -v brew >/dev/null 2>&1; then
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  else
    echo "-> Устанавливаю Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
    [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
  fi
fi
echo "[OK] Homebrew"

# 3. Node.js, pnpm, ffmpeg
brew_pkgs=()
command -v node   >/dev/null 2>&1 || brew_pkgs+=(node)
command -v pnpm   >/dev/null 2>&1 || brew_pkgs+=(pnpm)
command -v ffmpeg >/dev/null 2>&1 || brew_pkgs+=(ffmpeg)

if [ ${#brew_pkgs[@]} -gt 0 ]; then
  echo "-> Устанавливаю через brew: ${brew_pkgs[*]}"
  brew install "${brew_pkgs[@]}"
fi
echo "[OK] node $(node -v), pnpm $(pnpm -v), ffmpeg"

# 4. Rust
if ! command -v cargo >/dev/null 2>&1; then
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  else
    echo "-> Устанавливаю Rust (rustup)..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
fi
echo "[OK] rustc $(rustc --version)"

chmod +x Build-macOS.sh Setup-macOS.sh

echo
echo "Окружение готово! Дальше:"
echo "  ./Build-macOS.sh        # собрать Fetchr.app и .dmg"
echo "  ./Build-macOS.sh --dev  # или запустить сразу в dev-режиме"
