import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { ipc } from "@/lib/ipc";
import { notifyError } from "@/lib/notify";
import type { MuteSpan, WordHit } from "@/types/job";

import { buildEdl, buildExportMoments, buildSrt, DEFAULT_EDL_FPS } from "../exportFormats";
import { fileNameFromPath } from "../fetchrMuteSettings";
import { exportFileName } from "../transcriptExport";

interface MomentExportOptions {
  filePath: string | null;
  words: WordHit[] | null;
  /** Что заглушено с учётом неприменённых правок — то, что видит пользователь. */
  effectiveSpans: MuteSpan[];
  setNotice: (notice: string | null) => void;
}

/** Экспорт заглушённых моментов для монтажа: субтитры .srt и маркеры EDL. */
export function useMomentExport({
  filePath,
  words,
  effectiveSpans,
  setNotice,
}: MomentExportOptions) {
  const { t } = useTranslation();

  const save = useCallback(
    async (format: "srt" | "edl") => {
      if (!filePath) return;
      if (effectiveSpans.length === 0) {
        setNotice(t("fetchr_mute.export_nothing_muted"));
        return;
      }
      try {
        const moments = buildExportMoments(
          effectiveSpans,
          words ?? [],
          t("fetchr_mute.manual_fragment"),
        );
        const text =
          format === "srt"
            ? buildSrt(moments)
            : buildEdl(moments, { title: fileNameFromPath(filePath), fps: DEFAULT_EDL_FPS });
        const suffix = format === "srt" ? ".muted.srt" : ".markers.edl";
        // Свой фильтр диалога: иначе Windows подставит .txt из фильтра по умолчанию.
        const filter =
          format === "srt"
            ? { name: t("fetchr_mute.filter_srt"), extensions: ["srt"] }
            : { name: t("fetchr_mute.filter_edl"), extensions: ["edl"] };
        const savedPath = await ipc.saveTextFileDialog(
          exportFileName(filePath, suffix),
          text,
          filter,
        );
        if (savedPath) setNotice(t("fetchr_mute.notice_export_saved", { path: savedPath }));
      } catch (err) {
        notifyError(t("fetchr_mute.error_export"), err);
      }
    },
    [filePath, words, effectiveSpans, setNotice, t],
  );

  const exportSrt = useCallback(() => save("srt"), [save]);
  const exportEdl = useCallback(() => save("edl"), [save]);

  return { exportSrt, exportEdl };
}
