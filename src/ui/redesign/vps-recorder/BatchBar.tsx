import type { VpsRecordingMeta } from "@/lib/ipc";
import { useSettings } from "@/stores/settings";
import { useVpsRecorderStore } from "@/stores/vpsRecorder";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./RecordingList.module.css";
import { fmtBytes } from "./format";

/** Панель действий над выбранными записями, снизу списка. */
export function BatchBar({
  chosen,
  onDelete,
  onDone,
}: {
  chosen: VpsRecordingMeta[];
  onDelete: () => void;
  onDone: () => void;
}) {
  const directory = useSettings((state) => state.directory);
  const maxConcurrentJobs = useSettings((state) => state.maxConcurrentJobs);
  const downloading = useVpsRecorderStore((s) => Boolean(s.busy.batchDownload));
  const downloadRecordings = useVpsRecorderStore((s) => s.downloadRecordings);

  const downloadable = chosen.filter((recording) => recording.available);
  const bytes = downloadable.reduce((sum, recording) => sum + recording.video_size, 0);

  const download = async () => {
    await downloadRecordings(downloadable, directory, maxConcurrentJobs);
    onDone();
  };

  return (
    <div className={styles.batch} role="toolbar" aria-label="Действия с выбранными записями">
      <b className={styles.batchCount}>Выбрано: {chosen.length}</b>
      <span className={styles.batchSum}>{bytes > 0 ? fmtBytes(bytes) : ""}</span>
      <button
        type="button"
        className={styles.batchButton}
        disabled={!directory || downloadable.length === 0 || downloading}
        title={
          !directory
            ? "Сначала укажите папку в настройках"
            : downloadable.length === 0
              ? "Видео выбранных записей уже удалено с сервера"
              : "Скачать выбранные записи на компьютер"
        }
        onClick={() => void download()}
      >
        <RedesignIcon name={downloading ? "loading" : "download"} className="size-3.5" />
        Скачать
      </button>
      <button type="button" className={`${styles.batchButton} ${styles.batchDanger}`} onClick={onDelete}>
        <RedesignIcon name="trash" className="size-3.5" />
        Удалить
      </button>
      <button type="button" className={styles.batchClose} onClick={onDone} aria-label="Снять выбор" title="Снять выбор (Esc)">
        <RedesignIcon name="close" className="size-3" />
      </button>
    </div>
  );
}
