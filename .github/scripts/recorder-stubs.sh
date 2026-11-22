#!/usr/bin/env bash
# Пустые заглушки файлов VPS-рекордера, которые src-tauri/src/vps_ssh.rs
# встраивает через include_str!. Нужны только для сборки в CI, где
# vps-recorder/ нет (он в .gitignore). Существующие файлы не трогает.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p vps-recorder
for name in agent.py api.py session_io.py hot_tier.py fetchr-agent.service fetchr-rec-api.service; do
  [ -e "vps-recorder/$name" ] || : > "vps-recorder/$name"
done
[ -e vps-recorder/config.json ] || echo '{}' > vps-recorder/config.json
