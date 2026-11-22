import { useCallback, useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import { ipc } from "@/lib/ipc";
import { useFetchrMuteStore } from "@/stores/fetchrMute";
import type { FetchrMuteSettings, MuteSpan, WordHit } from "@/types/job";

import { formatTimecodeInput, parseTimecode } from "../timecode";
import type { FetchrMuteStore } from "../types";
import type { RecordEdit } from "./usePendingEdits";

export interface ManualRangeError {
  start: boolean;
  end: boolean;
  message: string;
}

interface MuteEditsOptions {
  store: FetchrMuteStore;
  fileStem: string | undefined;
  currentSettings: FetchrMuteSettings;
  /** Что заглушено с учётом неприменённых правок. */
  effectiveSpans: MuteSpan[];
  recordEdit: RecordEdit;
  /** Собрать файл с правками перед действием с ним; false — не вышло. */
  ensureApplied: () => Promise<boolean>;
  currentTime: number;
  duration: number;
}

// Спан из списка приходит с паддингами бэкенда (±30–35 мс), поэтому
// точное сравнение границ (допуск 0.01) исходный ручной фрагмент не
// находило — ищем по максимальному перекрытию.
function findManualSpanIndex(manualSpans: MuteSpan[], span: MuteSpan): number {
  let idx = -1;
  let bestOverlap = 0;
  manualSpans.forEach((m, i) => {
    const overlap = Math.min(m.end, span.end) - Math.max(m.start, span.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      idx = i;
    }
  });
  return idx;
}

const isValidSpan = (s: MuteSpan | undefined): s is MuteSpan =>
  !!s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start;

/**
 * Правки мута: ручные фрагменты, исключения, точечные правки и экспорт/импорт.
 * Правки копятся неприменёнными — файл пересобирается по «Применить».
 */
export function useMuteEdits({
  store,
  fileStem,
  currentSettings,
  effectiveSpans,
  recordEdit,
  ensureApplied,
  currentTime,
  duration,
}: MuteEditsOptions) {
  const { t } = useTranslation();
  const {
    filePath,
    manualSpans,
    excludedSpans,
    addManualSpan,
    removeManualSpan,
    addExcludedSpan,
    setManualSpans,
    setExcludedSpans,
    clearExcludedSpans,
    clearManualSpans,
    setError,
    setNotice,
  } = store;
  const [manualStart, setManualStart] = useState<string>("");
  const [manualEnd, setManualEnd] = useState<string>("");
  const [manualRangeOpen, setManualRangeOpen] = useState<boolean>(false);
  /** Инлайн-ошибка формы: какое поле подсветить; null — ошибки нет. */
  const [manualError, setManualError] = useState<ManualRangeError | null>(null);

  const changeManualStart = (value: string) => {
    setManualStart(value);
    setManualError(null);
  };
  const changeManualEnd = (value: string) => {
    setManualEnd(value);
    setManualError(null);
  };

  const addManualMoment = () => {
    const start = parseTimecode(manualStart);
    const end = parseTimecode(manualEnd);
    const startOk = start != null && Number.isFinite(start) && start >= 0;
    const endOk =
      end != null &&
      Number.isFinite(end) &&
      !(duration > 0 && end > duration) &&
      (start == null || !Number.isFinite(start) || end > start);
    if (!startOk || !endOk || start == null || end == null) {
      setManualError({ start: !startOk, end: !endOk, message: t("fetchr_mute.error_manual_range") });
      return;
    }
    setManualError(null);
    recordEdit(() => addManualSpan(start, end));
    setManualStart("");
    setManualEnd("");
  };

  const markStartAtPlayhead = () => {
    setManualError(null);
    setManualStart(formatTimecodeInput(currentTime));
    // Конец по умолчанию — +1с, чтобы фрагмент сразу был валидным
    if (!manualEnd) {
      setManualEnd(
        formatTimecodeInput(
          duration > 0 ? Math.min(currentTime + 1, duration) : currentTime + 1,
        ),
      );
    }
  };
  const markEndAtPlayhead = () => {
    setManualError(null);
    setManualEnd(formatTimecodeInput(currentTime));
  };

  // Убрать спан из мута: ручной — из manualSpans, авто — в исключения.
  // false — менять нечего (повторный клик по уже снятому месту).
  const releaseSpan = (span: MuteSpan): boolean => {
    if (span.word === "manual") {
      const idx = findManualSpanIndex(manualSpans, span);
      if (idx === -1) return false;
      removeManualSpan(idx);
      return true;
    }
    return addExcludedSpan(span);
  };

  // Удалить конкретный спан: ручной — из manualSpans, авто — в исключения
  const deleteSpan = (span: MuteSpan) => {
    recordEdit(() => releaseSpan(span));
  };

  // Точечные правки прямо в транскрипции: заглушить одно слово / вернуть звук
  // именно здесь, без словарей и таймкодов.
  const muteWordOccurrence = useCallback(
    (word: WordHit) => {
      const start = Math.max(0, word.start);
      const end = Math.max(start + 0.05, word.end);
      recordEdit(() => addManualSpan(start, end));
    },
    [addManualSpan, recordEdit],
  );

  const unmuteWordOccurrence = useCallback(
    (word: WordHit) => {
      const covering = effectiveSpans.filter(
        (span) => word.start < span.end - 0.01 && word.end > span.start + 0.01,
      );
      if (covering.length === 0) return;
      // Ручные фрагменты снимаются из manualSpans, автоматические — уходят в
      // исключения; и то и другое умеет deleteSpan.
      // releaseSpan читает только manualSpans/removeManualSpan/addExcludedSpan,
      // они в зависимостях ниже.
      recordEdit(() => covering.forEach((span) => releaseSpan(span)));
    },
    [effectiveSpans, manualSpans, removeManualSpan, addExcludedSpan, recordEdit],
  );

  const hasMuteEdits = excludedSpans.length > 0 || manualSpans.length > 0;
  const resetMuteEdits = () => {
    recordEdit(() => {
      clearExcludedSpans();
      clearManualSpans();
    });
  };

  // Экспорт/импорт правок мута: перенос ручных фрагментов и исключений
  // между машинами/сессиями, не привязываясь к истории приложения.
  const exportMuteEdits = async () => {
    // Экспорт описывает файл результата — сначала собираем его с правками.
    if (!(await ensureApplied())) return;
    const { spans, manualSpans, excludedSpans } = useFetchrMuteStore.getState();
    try {
      const payload = {
        kind: "fetchr-mute-edits",
        version: 1,
        file: filePath,
        exportedAt: new Date().toISOString(),
        spans: spans ?? [],
        manualSpans,
        excludedSpans,
        settings: currentSettings,
      };
      const stem = fileStem || "mute";
      const saved = await ipc.saveTextFileDialog(
        `${stem}_mute_edits.json`,
        JSON.stringify(payload, null, 2),
        { name: t("fetchr_mute.filter_edits_json"), extensions: ["json"] },
      );
      if (saved) setNotice(t("fetchr_mute.notice_edits_exported", { path: saved }));
    } catch (err) {
      setError(t("fetchr_mute.error_edits_export", { error: String(err) }));
    }
  };

  const importMuteEdits = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as {
        manualSpans?: MuteSpan[];
        excludedSpans?: MuteSpan[];
      };
      const manual = (parsed.manualSpans ?? [])
        .filter(isValidSpan)
        .map((s) => ({ word: "manual", start: s.start, end: s.end }));
      const excluded = (parsed.excludedSpans ?? [])
        .filter(isValidSpan)
        .map((s) => ({ word: s.word ?? "", start: s.start, end: s.end }));
      recordEdit(() => {
        setManualSpans(manual);
        setExcludedSpans(excluded);
      });
      setNotice(
        t("fetchr_mute.notice_edits_imported", {
          count: manual.length + excluded.length,
        }),
      );
    } catch (err) {
      setError(t("fetchr_mute.error_edits_import", { error: String(err) }));
    }
  };

  return {
    manualStart,
    setManualStart: changeManualStart,
    manualEnd,
    setManualEnd: changeManualEnd,
    manualError,
    manualRangeOpen,
    setManualRangeOpen,
    addManualMoment,
    markStartAtPlayhead,
    markEndAtPlayhead,
    deleteSpan,
    muteWordOccurrence,
    unmuteWordOccurrence,
    hasMuteEdits,
    resetMuteEdits,
    exportMuteEdits,
    importMuteEdits,
  };
}

export type MuteEdits = ReturnType<typeof useMuteEdits>;
