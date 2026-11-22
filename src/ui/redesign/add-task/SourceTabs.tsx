import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useFlipIndicator } from "@/hooks/useFlipIndicator";
import { cn } from "@/lib/utils";
import { PlatformIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./AddTaskModal.module.css";

export type AddTaskSource = "twitch" | "youtube" | "kick" | "wtv" | "m3u8" | "rtmp" | "local";

export interface SourceTabsProps {
  activeSource: AddTaskSource;
  onSourceChange: (source: AddTaskSource) => void;
  /** id панели, которой управляют вкладки (aria-controls). */
  panelId: string;
}

const tabs: Array<{ id: AddTaskSource; label: string; platform: string }> = [
  { id: "twitch", label: "twitch.tv", platform: "twitch" },
  { id: "youtube", label: "youtube.com", platform: "youtube" },
  { id: "kick", label: "kick.com", platform: "kick" },
  { id: "wtv", label: "w.tv", platform: "wtv" },
  { id: "m3u8", label: "m3u8", platform: "hls" },
  { id: "rtmp", label: "RTMP", platform: "rtmp" },
  { id: "local", label: "Файл", platform: "local" },
];

export const sourceTabId = (source: AddTaskSource) => `add-task-tab-${source}`;

export function SourceTabs({ activeSource, onSourceChange, panelId }: SourceTabsProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  // Пилюля выбранной вкладки переезжает к новой, как в промо-ролике
  const captureFlip = useFlipIndicator(activeSource, "addTaskSourceTab");

  const select = (id: AddTaskSource) => {
    if (id === activeSource) return;
    captureFlip();
    onSourceChange(id);
  };

  // Стрелки двигают выбор по кругу (автоактивация), Home/End — к краям.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = tabs.findIndex((tab) => tab.id === activeSource);
    const last = tabs.length - 1;
    const nextIndex =
      event.key === "ArrowRight"
        ? (current + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (current - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex];
    select(next.id);
    listRef.current?.querySelector<HTMLElement>(`#${sourceTabId(next.id)}`)?.focus();
  };

  return (
    <div className={styles.tabShell}>
      <div
        ref={listRef}
        className={styles.tabs}
        role="tablist"
        aria-label={t("add.source_type", "Тип источника")}
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const active = activeSource === tab.id;
          return (
            <button
              className={cn(styles.tab, active && styles.tabActive)}
              key={tab.id}
              id={sourceTabId(tab.id)}
              data-platform={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              onClick={() => select(tab.id)}
            >
              {active && <span data-flip-id="addTaskSourceTab" className={styles.tabPill} />}
              <PlatformIcon platform={tab.platform} className="size-4" />
              <span>{tab.id === "local" ? t("add.source_local", "Файл") : tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
