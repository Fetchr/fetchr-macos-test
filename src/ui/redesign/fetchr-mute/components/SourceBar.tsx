import { useRef } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import styles from "./SourceBar.module.css";
import { formatTime } from "../timecode";
import type { FileDetails } from "../types";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";

interface SourceBarProps {
  fileDetails: FileDetails | null;
  isVideo: boolean;
  duration: number;
  /** Готовый результат есть и обработка не идёт — показываем действия с ним. */
  hasResult: boolean;
  processing: boolean;
  onReveal: () => void;
  onSendToVocalRemover: () => void;
  onRerun: () => void;
  onExportEdits: () => void;
  onImportEdits: (event: React.ChangeEvent<HTMLInputElement>) => void;
  /** Есть ручные или исключённые отрезки — «Сбросить все правки» есть что сбросить. */
  hasSpanEdits: boolean;
  onResetEdits: () => void;
  onExportSrt: () => void;
  onExportEdl: () => void;
  onExportTxt: () => void;
  onClose: () => void;
}

/** Компактная строка файла: имя, длительность, повторный анализ, экспорт, «В папке» и «⋯». */
export function SourceBar({
  fileDetails,
  isVideo,
  duration,
  hasResult,
  processing,
  onReveal,
  onSendToVocalRemover,
  onRerun,
  onExportEdits,
  onImportEdits,
  hasSpanEdits,
  onResetEdits,
  onExportSrt,
  onExportEdl,
  onExportTxt,
  onClose,
}: SourceBarProps) {
  const { t } = useTranslation();
  const importRef = useRef<HTMLInputElement>(null);

  const exportItems: OverflowItem[] = [
    {
      id: "export-srt",
      label: t("fetchr_mute.export_srt_label"),
      hint: t("fetchr_mute.export_srt_hint"),
      icon: "download",
      onSelect: onExportSrt,
    },
    {
      id: "export-edl",
      label: t("fetchr_mute.export_edl_label"),
      hint: t("fetchr_mute.export_edl_hint"),
      icon: "download",
      onSelect: onExportEdl,
    },
    {
      id: "export-txt",
      label: t("fetchr_mute.export_txt_label"),
      hint: t("fetchr_mute.export_txt_hint"),
      icon: "download",
      onSelect: onExportTxt,
    },
  ];
  const resultItems: OverflowItem[] = hasResult
    ? [
        {
          id: "vocal",
          label: t("fetchr_mute.send_to_vocal_remover"),
          icon: "vocal",
          onSelect: onSendToVocalRemover,
        },
        {
          id: "export",
          label: t("fetchr_mute.menu_export_edits"),
          hint: t("fetchr_mute.menu_export_edits_hint"),
          icon: "download",
          onSelect: onExportEdits,
          separated: true,
        },
        {
          id: "import",
          label: t("fetchr_mute.menu_import_edits"),
          icon: "folder",
          onSelect: () => importRef.current?.click(),
        },
        {
          id: "reset",
          label: t("fetchr_mute.menu_reset_edits"),
          hint: t("fetchr_mute.menu_reset_edits_hint"),
          icon: "reset",
          onSelect: onResetEdits,
          inactive: !hasSpanEdits,
        },
      ]
    : [];
  const items: OverflowItem[] = [
    ...resultItems,
    {
      id: "close",
      label: t("fetchr_mute.zakryt_fayl"),
      icon: "close",
      onSelect: onClose,
      separated: hasResult,
    },
  ];

  return (
    <section
      className={cn(shared.source, styles.source)}
      aria-label={t("fetchr_mute.source_file_aria")}
    >
      <span className={styles.fileIcon} aria-hidden="true">
        <RedesignIcon name={isVideo ? "fileVideo" : "fileAudio"} />
      </span>
      <span className={styles.name} title={fileDetails?.name}>
        {fileDetails?.name}
      </span>
      {duration > 0 && <span className={styles.duration}>{formatTime(duration)}</span>}
      <span className={shared.controlsSpacer} />
      {hasResult && (
        <button
          type="button"
          className={shared.ghostButton}
          onClick={onRerun}
          title={t("fetchr_mute.reanalyze_hint")}
        >
          <RedesignIcon name="refresh" />
          {t("fetchr_mute.reanalyze")}
        </button>
      )}
      {hasResult && (
        <OverflowMenu
          label={t("fetchr_mute.export_menu_aria")}
          items={exportItems}
          disabled={processing}
          trigger={{ text: t("fetchr_mute.export_menu"), icon: "download" }}
        />
      )}
      {hasResult && (
        <button
          type="button"
          className={shared.secondaryButton}
          onClick={onReveal}
          title={t("fetchr_mute.pokazat_obrabotannyy_fayl_v_provodnike")}
        >
          <RedesignIcon name="folder" />
          {t("fetchr_mute.v_papke")}
        </button>
      )}
      <OverflowMenu label={t("fetchr_mute.more_actions")} items={items} disabled={processing} />
      <input
        ref={importRef}
        type="file"
        accept=".json,application/json"
        className={shared.hiddenInput}
        onChange={onImportEdits}
      />
    </section>
  );
}
