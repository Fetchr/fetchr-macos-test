import type { KeyboardEvent, RefObject } from "react";
import { useTranslation } from "react-i18next";

import { useDownloadHistory } from "@/stores/downloadHistory";
import { PlatformIcon, RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./DownloadOverlay.module.css";
import { shortUrl } from "./linkInput";

interface Props {
  onPick: (query: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

const KNOWN_PLATFORMS = new Set(["twitch", "kick", "youtube", "vk", "wtv"]);

/** Недавние каналы и записи в пустом окне; стрелки ходят по списку, Enter открывает. */
export function RecentLinks({ onPick, inputRef }: Props) {
  const { t } = useTranslation();
  const recent = useDownloadHistory((s) => s.recent);
  const forget = useDownloadHistory((s) => s.forget);
  const clear = useDownloadHistory((s) => s.clear);

  if (recent.length === 0) return null;

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const items = Array.from(
      event.currentTarget.closest("ul")?.querySelectorAll<HTMLButtonElement>("[data-recent-item]") ?? [],
    );
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[Math.min(index + 1, items.length - 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) inputRef.current?.focus();
      else items[index - 1]?.focus();
    } else if (event.key === "Delete") {
      event.preventDefault();
      forget(recent[index].query);
      (items[index + 1] ?? items[index - 1])?.focus();
    }
  };

  return (
    <section className={styles.recent} aria-labelledby="recent-title">
      <div className={styles.recentHead}>
        <span id="recent-title" className={styles.sectionLabel}>
          {t("simple.recent", "Недавние")}
        </span>
        <button type="button" className={styles.ghost} onClick={clear}>
          {t("simple.recent_clear", "Очистить")}
        </button>
      </div>
      <ul className={styles.recentList}>
        {recent.map((item, index) => (
          <li key={item.query} className={styles.recentRow}>
            <button
              type="button"
              data-recent-item
              className={styles.recentItem}
              onClick={() => onPick(item.query)}
              onKeyDown={(event) => move(event, index)}
              title={item.query}
            >
              {KNOWN_PLATFORMS.has(item.platform) ? (
                <PlatformIcon platform={item.platform} className="size-3.5" />
              ) : (
                <RedesignIcon name="link" className="size-3.5" />
              )}
              <span className={styles.recentLabel}>{item.label}</span>
              <span className={styles.recentMeta}>
                {item.typeLabel} · {shortUrl(item.query, 28)}
              </span>
            </button>
            <button
              type="button"
              className={styles.clearButton}
              onClick={() => forget(item.query)}
              aria-label={t("simple.recent_forget", "Убрать из недавних")}
              title={t("simple.recent_forget", "Убрать из недавних")}
            >
              <RedesignIcon name="close" className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
