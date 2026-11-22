"""Массовая замена хардкод-цветов и easing-кривых на fetchr-токены.
Проходит по src/ui/**/*.module.css (кроме fetchrTokens.css) и src/styles/globals.css не трогает.

Карта замен лежит в lib/token-map.json — тот же файл читает валидатор
scripts/validate-tokens.cjs. Держать две копии нельзя: валидатор начнёт
советовать токены, которых кодмод не знает.
"""
import json
import sys
from pathlib import Path

# Консоль Windows по умолчанию cp1252: без этого печать русского отчёта
# роняет скрипт UnicodeEncodeError уже после записи файлов.
sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path("src/ui")
MAP_FILE = Path(__file__).parent / "lib" / "token-map.json"

_map = json.loads(MAP_FILE.read_text(encoding="utf-8"))
# Порядок важен: сначала длинные rgba-строки, потом hex.
COLOR_MAP = [tuple(pair) for pair in _map["color"]]
EASE_MAP = [tuple(pair) for pair in _map["ease"]]

def main() -> None:
    total_files = 0
    total_subs = 0
    for path in sorted(ROOT.rglob("*.module.css")):
        if path.name == "fetchrTokens.css":
            continue
        text = path.read_text(encoding="utf-8")
        original = text
        count = 0
        for old, new in COLOR_MAP + EASE_MAP:
            n = text.count(old)
            if n:
                text = text.replace(old, new)
                count += n
        if text != original:
            path.write_text(text, encoding="utf-8", newline="")
            total_files += 1
            total_subs += count
            print(f"{path}: {count} замен")
    print(f"\nИтого: {total_files} файлов, {total_subs} замен")

if __name__ == "__main__":
    main()
