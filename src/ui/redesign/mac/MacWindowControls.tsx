import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";

import styles from "./MacWindowControls.module.css";

type WindowAction = "close" | "minimize" | "toggleMaximize";

function runWindowAction(action: WindowAction): void {
  try {
    const win = getCurrentWindow();
    const task = action === "close" ? win.close() : action === "minimize" ? win.minimize() : win.toggleMaximize();
    task.catch((error: unknown) => console.warn(`Window ${action} failed:`, error));
  } catch (error) {
    console.warn(`Window ${action} unavailable:`, error);
  }
}

/**
 * Кнопки окна в стиле macOS для интерфейса «MacOS» на Windows и Linux, где
 * окно без системной рамки. На Mac их рисует система (titleBarStyle Overlay).
 */
export function MacWindowControls() {
  const { t } = useTranslation();
  return (
    <div className={styles.controls}>
      <button
        type="button"
        className={`${styles.light} ${styles.close}`}
        aria-label={t("mac.window_close", "Закрыть")}
        onClick={() => runWindowAction("close")}
      />
      <button
        type="button"
        className={`${styles.light} ${styles.minimize}`}
        aria-label={t("mac.window_minimize", "Свернуть")}
        onClick={() => runWindowAction("minimize")}
      />
      <button
        type="button"
        className={`${styles.light} ${styles.zoom}`}
        aria-label={t("mac.window_zoom", "Развернуть")}
        onClick={() => runWindowAction("toggleMaximize")}
      />
    </div>
  );
}
