import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import type { HistoryItem } from "@/types/job";

import shared from "../shared.module.css";
import styles from "./RecentFiles.module.css";
import { isVideoFile } from "../constants";
import type { HistoryMissing } from "../types";
import { DeleteHistoryConfirm } from "./DeleteHistoryConfirm";

interface RecentFilesProps {
  history: HistoryItem[];
  historyMissing: HistoryMissing;
  currentRecognitionVersion: number | null;
  onOpen: (item: HistoryItem) => void;
  onDelete: (id: string) => void;
}

export function RecentFiles({
  history,
  historyMissing,
  currentRecognitionVersion,
  onOpen,
  onDelete,
}: RecentFilesProps) {
  const { t } = useTranslation();
  // Запись, удаление которой ждёт подтверждения.
  const [pendingDelete, setPendingDelete] = useState<HistoryItem | null>(null);
  return (
    <section className={shared.card} aria-label={t("fetchr_mute.history_aria")}>
      <header className={shared.sectionHead}>
        <h2 className={shared.sectionTitle}>
          {t("fetchr_mute.istoriya")}
          <span className={shared.count}>{history.length}</span>
        </h2>
      </header>
      {pendingDelete && (
        <DeleteHistoryConfirm
          fileName={pendingDelete.fileName}
          onConfirm={() => {
            onDelete(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      <ul className={styles.recentList}>
        {history.map((item) => (
          <RecentFileRow
            key={item.id}
            item={item}
            missing={historyMissing[item.id]}
            outdated={
              currentRecognitionVersion !== null &&
              item.recognitionVersion != null &&
              item.recognitionVersion !== currentRecognitionVersion
            }
            onOpen={onOpen}
            onDelete={() => setPendingDelete(item)}
          />
        ))}
      </ul>
    </section>
  );
}

interface RecentFileRowProps {
  item: HistoryItem;
  missing: HistoryMissing[string] | undefined;
  outdated: boolean;
  onOpen: (item: HistoryItem) => void;
  onDelete: () => void;
}

function RecentFileRow({ item, missing, outdated, onOpen, onDelete }: RecentFileRowProps) {
  const { t } = useTranslation();
  const spanCount = item.spans?.length || 0;
  return (
    <li className={styles.recentItem}>
      <button
        type="button"
        className={styles.recentOpen}
        onClick={() => onOpen(item)}
      >
        <span className={styles.recentIcon} aria-hidden="true">
          <RedesignIcon name={isVideoFile(item.filePath) ? "video" : "audio"} />
        </span>
        <span className={styles.recentText}>
          <span className={styles.recentName}>{item.fileName}</span>
          <span className={styles.recentMeta}>
            {new Date(item.date).toLocaleString()}
          </span>
        </span>
        {missing?.source && (
          <span className={cn(styles.pill, styles.pillWarn)}>
            {t("fetchr_mute.ishodnik_ne_nayden")}
          </span>
        )}
        {!missing?.source && missing?.output && (
          <span className={cn(styles.pill, styles.pillWarn)}>
            {t("fetchr_mute.rezultat_udalen")}
          </span>
        )}
        {outdated && (
          <span
            className={styles.pill}
            title={t("fetchr_mute.zapisano_staroy_versiey_analiza_posle")}
          >
            {t("fetchr_mute.old_analysis")}
          </span>
        )}
        <span
          className={cn(
            styles.pill,
            (item.spans?.length ?? 0) > 0 && styles.pillDanger,
          )}
        >
          {t("fetchr_mute.mats_count", { count: spanCount })}
        </span>
      </button>
      <button
        type="button"
        className={cn(shared.historyDelete, styles.recentDelete)}
        onClick={onDelete}
        aria-label={t("fetchr_mute.udalit_iz_istorii")}
        title={t("fetchr_mute.udalit_iz_istorii")}
      >
        <RedesignIcon name="trash" />
      </button>
    </li>
  );
}
