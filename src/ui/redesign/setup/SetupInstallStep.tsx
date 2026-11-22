import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc, onSetupProgress } from "@/lib/ipc";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./FirstRunSetup.module.css";
import type { SetupComponent } from "./setupTools";

type ItemState = "waiting" | "running" | "done" | "failed";

interface ItemProgress {
  state: ItemState;
  percent: number;
  message: string | null;
}

interface SetupInstallStepProps {
  components: SetupComponent[];
  /** true — всё поставлено или пропущено, можно идти дальше */
  onSettled: (settled: boolean) => void;
}

/**
 * Ставит нужное для выбранных инструментов, по одному компоненту за раз.
 * Уже установленное пропускается: команда бэкенда идемпотентна.
 */
export function SetupInstallStep({ components, onSettled }: SetupInstallStepProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Record<string, ItemProgress>>(() =>
    Object.fromEntries(components.map((id) => [id, { state: "waiting", percent: 0, message: null }])),
  );
  const [failed, setFailed] = useState<string | null>(null);
  const runningRef = useRef(false);

  const patch = useCallback((id: string, next: Partial<ItemProgress>) => {
    setItems((current) => ({ ...current, [id]: { ...current[id], ...next } }));
  }, []);

  const run = useCallback(
    async (from: number) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setFailed(null);
      onSettled(false);
      try {
        const status = await ipc.setupComponentsStatus().catch(() => []);
        const ready = new Set(status.filter((item) => item.ready).map((item) => item.id));
        for (const id of components.slice(from)) {
          if (ready.has(id)) {
            patch(id, { state: "done", percent: 100, message: null });
            continue;
          }
          patch(id, { state: "running", percent: 0, message: null });
          try {
            await ipc.setupInstallComponent(id);
            patch(id, { state: "done", percent: 100, message: null });
          } catch (error) {
            patch(id, { state: "failed", message: String(error) });
            setFailed(id);
            return;
          }
        }
        onSettled(true);
      } finally {
        runningRef.current = false;
      }
    },
    [components, onSettled, patch],
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void onSetupProgress((payload) => {
      const id = (payload.taskId ?? "").replace(/^setup_/, "");
      setItems((current) =>
        current[id]?.state === "running"
          ? { ...current, [id]: { ...current[id], percent: payload.percent, message: payload.message } }
          : current,
      );
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    void run(0);
    return () => {
      disposed = true;
      unlisten?.();
    };
    // Установка стартует один раз при входе на шаг.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skip = () => {
    if (!failed) return;
    const index = components.indexOf(failed as SetupComponent);
    patch(failed, { state: "done", message: t("setup.install.skipped") });
    void run(index + 1);
  };

  if (components.length === 0) {
    return <p className={styles.lead}>{t("setup.install.nothing")}</p>;
  }

  return (
    <div className={styles.installList}>
      {components.map((id) => {
        const item = items[id];
        return (
          <div key={id} className={styles.installItem} data-state={item.state}>
            <span className={styles.installIcon} aria-hidden>
              <RedesignIcon
                name={
                  item.state === "done"
                    ? "check"
                    : item.state === "failed"
                      ? "alert"
                      : item.state === "running"
                        ? "loading"
                        : "download"
                }
                className={item.state === "running" ? "size-4 animate-spin" : "size-4"}
              />
            </span>
            <div className={styles.installBody}>
              <div className={styles.installHead}>
                <span>{t(`setup.components.${id}`)}</span>
                {item.state === "running" && <span className={styles.installPercent}>{Math.floor(item.percent)}%</span>}
              </div>
              <div className={styles.installBar}>
                <div
                  className={styles.installFill}
                  style={{ width: `${item.state === "done" ? 100 : item.percent}%` }}
                />
              </div>
              <div className={styles.installMessage} title={item.message ?? undefined}>
                {item.message ?? t(`setup.install.${item.state}`)}
              </div>
            </div>
          </div>
        );
      })}

      {failed && (
        <div className={styles.installActions}>
          <button className={styles.primary} type="button" onClick={() => void run(components.indexOf(failed as SetupComponent))}>
            <RedesignIcon name="refresh" className="size-3.5" />
            {t("setup.install.retry")}
          </button>
          <button className={styles.ghost} type="button" onClick={skip}>
            {t("setup.install.skip")}
          </button>
        </div>
      )}
    </div>
  );
}
