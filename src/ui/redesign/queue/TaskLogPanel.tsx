import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc } from "@/lib/ipc";

import styles from "./QueuePage.module.css";

/** Полный лог задачи: живой буфер, пока задача идёт, и локальная копия после. */
export function TaskLogPanel({ jobId, name, running }: { jobId: string; name: string; running: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const viewRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () =>
      ipc
        .jobLogText(jobId)
        .then((value) => {
          if (alive) setText(value ?? "");
        })
        .catch(() => {
          if (alive) setText("");
        });
    void load();
    if (!running) return () => void (alive = false);
    const timer = window.setInterval(load, 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open, jobId, running]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && running) view.scrollTop = view.scrollHeight;
  }, [text, running]);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 1600);
  };

  const fetchText = async () => text ?? (await ipc.jobLogText(jobId)) ?? "";

  const save = async () => {
    const contents = await fetchText();
    const safe = name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "job";
    const saved = await ipc.saveTextFileDialog(`${safe}.log.txt`, contents);
    if (saved) flash(t("queue.log.saved", "Сохранено"));
  };

  const copy = async () => {
    await navigator.clipboard.writeText(await fetchText());
    flash(t("common.copied", "Скопировано"));
  };

  return (
    <div className={styles.taskLog}>
      <div className={styles.taskLogBar}>
        <span>{t("queue.log.title", "Лог задачи")}</span>
        {notice && <em>{notice}</em>}
        <button className={styles.button} type="button" onClick={() => setOpen((value) => !value)}>
          {open ? t("queue.log.hide", "Скрыть") : t("queue.log.show", "Показать")}
        </button>
        <button className={styles.button} type="button" onClick={() => void copy()}>
          {t("common.copy", "Копировать")}
        </button>
        <button className={styles.button} type="button" onClick={() => void save()}>
          {t("queue.log.save", "Сохранить")}
        </button>
      </div>
      {open && (
        <pre ref={viewRef} className={styles.taskLogView}>
          {text === null ? t("common.loading", "Загрузка…") : text || t("queue.log.empty", "Лог пуст")}
        </pre>
      )}
    </div>
  );
}
