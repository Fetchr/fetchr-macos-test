import { useId } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import { activateOnKey } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { DemoSlot, MuteDemo } from "@/ui/redesign/demos/DemoSlot";
import type { HistoryItem } from "@/types/job";

import shared from "../shared.module.css";
import styles from "./EmptyState.module.css";
import { DROP_FORMATS } from "../constants";
import type { HistoryMissing } from "../types";
import { RecentFiles } from "./RecentFiles";

interface EmptyStateProps {
  dragActive: boolean;
  onDrag: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onChooseFile: () => void;
  history: HistoryItem[];
  historyMissing: HistoryMissing;
  currentRecognitionVersion: number | null;
  onOpenHistoryItem: (item: HistoryItem) => void;
  onDeleteHistoryItem: (id: string) => void;
}

/** Файл ещё не выбран: зона перетаскивания и недавние файлы. */
export function EmptyState({
  dragActive,
  onDrag,
  onDrop,
  onChooseFile,
  history,
  historyMissing,
  currentRecognitionVersion,
  onOpenHistoryItem,
  onDeleteHistoryItem,
}: EmptyStateProps) {
  const { t } = useTranslation();
  const hintId = useId();
  const formatsId = useId();
  return (
    <>
      <div
        className={cn(
          shared.dropZone,
          styles.dropZone,
          dragActive && shared.dropZoneActive,
          dragActive && styles.dropZoneActive,
        )}
        role="button"
        tabIndex={0}
        aria-label={t("fetchr_mute.drop_zone_aria")}
        aria-describedby={`${hintId} ${formatsId}`}
        onDragEnter={onDrag}
        onDragOver={onDrag}
        onDragLeave={onDrag}
        onDrop={onDrop}
        onClick={onChooseFile}
        onKeyDown={activateOnKey(onChooseFile)}
      >
        <DemoSlot demo={MuteDemo} height={216} />
        <span className={shared.dropTitle}>
          {dragActive
            ? t("fetchr_mute.otpustite_fayl")
            : t("purevoice.drag_prompt")}
        </span>
        <span id={hintId} className={shared.dropHint}>
          {t("fetchr_mute.video_ili_audio")}
        </span>
        <span id={formatsId} className={styles.srOnly}>
          {t("fetchr_mute.drop_formats_aria", { formats: DROP_FORMATS.join(", ") })}
        </span>
      </div>

      {history.length > 0 && (
        <RecentFiles
          history={history}
          historyMissing={historyMissing}
          currentRecognitionVersion={currentRecognitionVersion}
          onOpen={onOpenHistoryItem}
          onDelete={onDeleteHistoryItem}
        />
      )}
    </>
  );
}
