import { useNavigate } from "@tanstack/react-router";

import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./VpsRecorderPage.module.css";

/** Download buttons stay disabled without a folder; say why, next to them. */
export function NeedDownloadFolder() {
  const navigate = useNavigate();
  return (
    <div className={styles.noticeBox} role="note">
      <RedesignIcon name="folder" />
      <span className={styles.noticeText}>Чтобы скачивать, выберите папку для загрузок.</span>
      <button type="button" className={styles.ghostButton} onClick={() => void navigate({ to: "/settings" })}>
        Открыть настройки
      </button>
    </div>
  );
}
