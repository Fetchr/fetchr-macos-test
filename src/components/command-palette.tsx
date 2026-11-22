import { Command } from "cmdk";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useFocusTrap } from "@/hooks/useFocusTrap";
import { ipc } from "@/lib/ipc";
import { useUI } from "@/stores/ui";
import { useSettings } from "@/stores/settings";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";
import { Kbd } from "./kbd";
import styles from "./command-palette.module.css";
import { backdropDismiss } from "@/lib/backdrop";

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  const close = useUI((s) => s.closePalette);
  const openAdd = useUI((s) => s.openAddDialog);
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const locale = useSettings((s) => s.locale);
  const setLocale = useSettings((s) => s.setLocale);
  const directory = useSettings((s) => s.directory);
  const maxConcurrentJobs = useSettings((s) => s.maxConcurrentJobs);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const run = (fn: () => void | Promise<void>) => {
    close();
    void Promise.resolve().then(fn);
  };

  if (!open) return null;

  // Иконки — те же, что у вкладок топбара: палитра и навигация говорят
  // на одном языке. Сочетания G+… обрабатывает app-layout.
  return (
    <div className={styles.overlay} {...backdropDismiss(close)} role="presentation">
      <div
        ref={trapRef}
        className={styles.card}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.placeholder")}
      >
        <Command loop>
          <div className={styles.search}>
            <RedesignIcon name="finder" className={styles.searchIcon} />
            <Command.Input autoFocus placeholder={t("palette.placeholder")} className={styles.input} />
            <Kbd>Esc</Kbd>
          </div>
          <Command.List className={styles.list}>
            <Command.Empty className={styles.empty}>{t("palette.empty", "Ничего не найдено")}</Command.Empty>

            <Command.Group heading={t("palette.group_actions")} className={styles.group}>
              <Item icon="add" label={t("palette.add_stream")} hint={["Ctrl", "N"]} onSelect={() => run(openAdd)} />
              <Item icon="play" label={t("palette.start_queue")} hint={["Ctrl", "↵"]} onSelect={() => run(() => ipc.startQueue(maxConcurrentJobs))} />
              <Item icon="pause" label={t("palette.pause_queue")} onSelect={() => run(() => ipc.pauseQueue())} />
              <Item icon="trash" label={t("palette.clear_completed")} onSelect={() => run(() => ipc.clearCompleted())} />
            </Command.Group>

            <Command.Group heading={t("palette.group_navigate")} className={styles.group}>
              <Item icon="queue" label={t("palette.goto_queue")} hint={["G", "Q"]} onSelect={() => run(() => navigate({ to: "/queue" }))} />
              <Item icon="live" label={t("palette.goto_live_recorder", "Открыть Запись стримов")} hint={["G", "I"]} onSelect={() => run(() => navigate({ to: "/live-recorder" }))} />
              <Item icon="finder" label={t("palette.goto_finder")} hint={["G", "F"]} onSelect={() => run(() => navigate({ to: "/finder" }))} />
              <Item icon="chat" label={t("palette.goto_chat_render")} hint={["G", "C"]} onSelect={() => run(() => navigate({ to: "/chat-render" }))} />
              <Item icon="blur" label={t("palette.goto_sponsor_blur")} hint={["G", "P"]} onSelect={() => run(() => navigate({ to: "/sponsor-blur" }))} />
              <Item icon="mute" label={t("palette.goto_fetchr_mute", "Открыть «Удалить маты»")} hint={["G", "V"]} onSelect={() => run(() => navigate({ to: "/fetchr-mute" }))} />
              <Item icon="vocal" label={t("palette.goto_vocal_remover", "Go to Vocal Remover")} hint={["G", "R"]} onSelect={() => run(() => navigate({ to: "/vocal-remover" }))} />
              <Item icon="logs" label={t("palette.goto_logs")} hint={["G", "L"]} onSelect={() => run(() => navigate({ to: "/logs" }))} />
              <Item icon="settings" label={t("palette.goto_settings")} hint={["Ctrl", ","]} onSelect={() => run(() => navigate({ to: "/settings" }))} />
            </Command.Group>

            <Command.Group heading={t("palette.group_app", "Приложение")} className={styles.group}>
              <Item
                icon="folder"
                label={t("palette.open_downloads")}
                onSelect={() =>
                  run(() => {
                    if (directory) void ipc.openFolder(directory);
                  })
                }
              />
              <Item
                icon="source"
                label={t("palette.toggle_language")}
                onSelect={() =>
                  run(() => {
                    const next = locale === "ru" ? "en" : "ru";
                    setLocale(next);
                    void i18n.changeLanguage(next);
                    localStorage.setItem("fetchr-locale", next);
                  })
                }
              />
            </Command.Group>
          </Command.List>
        </Command>
        <div className={styles.footer} aria-hidden>
          <span className={styles.hint}>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t("palette.hint_navigate", "навигация")}
          </span>
          <span className={styles.hint}>
            <Kbd>↵</Kbd>
            {t("palette.hint_open", "открыть")}
          </span>
          <span className={styles.hint}>
            <Kbd>Esc</Kbd>
            {t("palette.hint_close", "закрыть")}
          </span>
        </div>
      </div>
    </div>
  );
}

interface ItemProps {
  icon: RedesignIconName;
  label: string;
  hint?: string[];
  onSelect: () => void;
}

function Item({ icon, label, hint, onSelect }: ItemProps) {
  return (
    <Command.Item value={label} onSelect={onSelect} className={styles.item}>
      <RedesignIcon name={icon} className={styles.itemIcon} />
      <span className={styles.itemLabel}>{label}</span>
      {hint && (
        <span className={styles.keys}>
          {hint.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
      )}
    </Command.Item>
  );
}
