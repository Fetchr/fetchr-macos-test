import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useGsapPresence } from "@/hooks/useGsapPresence";
import { cn } from "@/lib/utils";
import { useBoot } from "@/stores/boot";
import { useUI } from "@/stores/ui";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { modalIn, modalOut } from "@/ui/redesign/theme/gsapMotion";

import { UpdateArt } from "./UpdateArt";
import styles from "./UpdateModal.module.css";
import { bundledWhatsNew } from "./bundledNotes";
import { buildPages, CATEGORY_TITLE } from "./updatePages";
import { whatsNewFromVersion } from "./WhatsNewTrigger";
import { backdropDismiss } from "@/lib/backdrop";

/**
 * «Что нового»: новости установленной версии по страницам, у каждой сверху
 * своя картинка или GIF, снизу текст. Листается стрелками, точками и
 * клавиатурой. Обновления ставятся сами при запуске, поэтому кнопки
 * «Обновить» здесь нет.
 */
export function UpdateModal() {
  const { t, i18n } = useTranslation();
  const updatedFrom = useBoot((s) => s.updatedFrom);
  const whatsNewOpen = useUI((s) => s.whatsNewOpen);
  const close = useUI((s) => s.closeWhatsNew);
  // Заметки вшиты в эту версию: окно работает без сервера, даже офлайн.
  const bundled = useMemo(
    () => (whatsNewOpen ? bundledWhatsNew(whatsNewFromVersion(updatedFrom)) : null),
    [whatsNewOpen, updatedFrom],
  );
  const updateStatus = bundled;
  const open = Boolean(updateStatus);
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const { shouldRender, ref: modalRef } = useGsapPresence<HTMLDivElement>(open, (element, direction) =>
    direction === "in" ? modalIn(backdropRef.current, element) : modalOut(backdropRef.current, element),
  );

  const notes = useMemo(() => (updateStatus ? localizedNotes(updateStatus, i18n.language) : null), [updateStatus, i18n.language]);
  const pages = useMemo(
    () => (updateStatus ? buildPages(updateStatus, i18n.language, notes) : []),
    [updateStatus, i18n.language, notes],
  );
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  const go = (next: number) => {
    const clamped = Math.max(0, Math.min(pages.length - 1, next));
    if (clamped === index) return;
    setDirection(clamped > index ? 1 : -1);
    setIndex(clamped);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") go(index + 1);
      else if (event.key === "ArrowLeft") go(index - 1);
      else if (event.key === "Escape") close();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!shouldRender || !updateStatus) return null;
  const page = pages[index] ?? pages[0];
  const last = index >= pages.length - 1;

  return (
    <div ref={backdropRef} className={`${fetchrThemeClassName} ${styles.backdrop}`} role="presentation" {...backdropDismiss(close)}>
      <div
        ref={(node) => {
          modalRef.current = node;
          trapRef.current = node;
        }}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button className={styles.closeButton} type="button" aria-label={t("settings.updates.close_btn", "Закрыть")} onClick={close}>
          <RedesignIcon name="close" className="size-4" />
        </button>

        <div className={styles.slide} key={index} data-dir={direction}>
          {page && <UpdateArt category={page.category} media={page.media} />}
          <div className={styles.text}>
            <div className={styles.kicker}>
              <span className={styles.version}>
                {updateStatus.current_version && (
                  <>
                    {updateStatus.current_version} <span>→</span>{" "}
                  </>
                )}
                <b>{updateStatus.version}</b>
              </span>
              {page && page.category !== "general" && <span className={styles.category}>{CATEGORY_TITLE[page.category]}</span>}
            </div>
            <h2 className={styles.title} id="update-modal-title">
              {page?.title ?? `Fetchr ${updateStatus.version}`}
            </h2>
            {page && page.items.length > 0 && (
              <ul className={styles.items}>
                {page.items.map((item, i) => (
                  <li key={i} style={{ animationDelay: `${0.08 + i * 0.05}s` }}>
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <footer className={styles.footer}>
          <div className={styles.dots} role="tablist" aria-label="Страницы обновления">
            {pages.map((p, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={`${i + 1}: ${p.title}`}
                className={cn(styles.dot, i === index && styles.dotActive)}
                onClick={() => go(i)}
              />
            ))}
          </div>
          <span className={styles.spacer} />
          {index > 0 && (
            <button className={styles.button} type="button" onClick={() => go(index - 1)}>
              Назад
            </button>
          )}
          {last ? (
            <button className={cn(styles.button, styles.primaryButton)} type="button" onClick={close}>
              Понятно
            </button>
          ) : (
            <button className={cn(styles.button, styles.primaryButton)} type="button" onClick={() => go(index + 1)}>
              Далее
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function localizedNotes(
  status: {
    notes: string | null;
    notes_i18n: Record<string, string> | null;
  },
  language: string,
) {
  const exact = status.notes_i18n?.[language];
  const base = status.notes_i18n?.[language.split("-")[0]];
  return exact || base || status.notes;
}
