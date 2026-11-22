"""Второй проход: хардкод-поверхности -> семантические токены, снятие blur с панелей."""
from pathlib import Path

ROOT = Path("src/ui")

SURFACE_MAP = [
    ("rgba(18, 21, 26, 0.45)", "var(--fetchr-color-panel)"),
    ("rgba(18, 21, 26, 0.40)", "var(--fetchr-color-panel)"),
    ("rgba(18, 21, 26, 0.92)", "var(--fetchr-color-panel-elevated)"),
    ("rgba(25, 29, 36, 0.76)", "var(--fetchr-color-panel-raised)"),
    ("rgba(25, 29, 36, 0.6)", "var(--fetchr-color-panel-raised)"),
    ("rgba(25, 29, 36, 0.4)", "var(--fetchr-color-panel-raised)"),
    ("rgba(34, 39, 49, 0.92)", "var(--fetchr-color-panel-hover)"),
    ("rgba(34, 39, 49, 0.7)", "var(--fetchr-color-panel-hover)"),
    ("rgba(11, 13, 17, 0.55)", "var(--fetchr-color-panel-inset)"),
    ("rgba(11, 13, 17, 0.45)", "var(--fetchr-color-panel-inset)"),
    ("rgba(11, 13, 17, 0.42)", "var(--fetchr-color-panel-inset)"),
]

# blur, который снимаем с плоских панелей (12px saturate 180%)
PANEL_BLUR = [
    "  backdrop-filter: blur(12px) saturate(180%);\n  -webkit-backdrop-filter: blur(12px) saturate(180%);\n",
    "  backdrop-filter: blur(12px) saturate(180%);\n",
    "  -webkit-backdrop-filter: blur(12px) saturate(180%);\n",
]

def main() -> None:
    total_files = 0
    total_subs = 0
    for path in sorted(ROOT.rglob("*.module.css")):
        text = path.read_text(encoding="utf-8")
        original = text
        count = 0
        for old, new in SURFACE_MAP:
            n = text.count(old)
            if n:
                text = text.replace(old, new)
                count += n
        for blur in PANEL_BLUR:
            n = text.count(blur)
            if n:
                text = text.replace(blur, "")
                count += n
        if text != original:
            path.write_text(text, encoding="utf-8", newline="")
            total_files += 1
            total_subs += count
            print(f"{path}: {count} замен")
    print(f"\nИтого: {total_files} файлов, {total_subs} замен")

if __name__ == "__main__":
    main()
