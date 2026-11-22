import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useFetchrMuteStore, type NoticeAction, type RecensorOutcome } from "@/stores/fetchrMute";
import { useFetchrMuteEditsStore } from "@/stores/fetchrMuteEdits";
import type { MuteSpan } from "@/types/job";

import {
  deriveEffectiveSpans,
  editStateFromSettings,
  editStatesEqual,
  pendingEditCount,
  type MuteEditState,
} from "../editModel";
import type { FetchrMuteStore } from "../types";
import type { FetchrMuteSettingsState } from "./useFetchrMuteSettings";

interface PendingEditsOptions {
  store: FetchrMuteStore;
  settings: FetchrMuteSettingsState;
  binariesDir: string | null;
}

const EMPTY_SPANS: MuteSpan[] = [];

/**
 * Неприменённые правки результата: каждая правка меняет только текущий набор,
 * файл пересобирается одним рендером по «Применить». Отсюда же — эффективные
 * спаны для подсветки, отмена/повтор и сброс.
 */
export function usePendingEdits({ store, settings, binariesDir }: PendingEditsOptions) {
  const { t } = useTranslation();
  const applied = useFetchrMuteEditsStore((s) => s.applied);
  const canUndo = useFetchrMuteEditsStore((s) => s.past.length > 0);
  const canRedo = useFetchrMuteEditsStore((s) => s.future.length > 0);
  const { outputPath, words, spans, processing, manualSpans, excludedSpans } = store;
  const { getSettings, restoreEditValues } = settings;
  const hasResult = Boolean(outputPath && words && !processing);

  const current = useMemo(
    () => editStateFromSettings(settings.currentSettings, manualSpans, excludedSpans),
    [settings.currentSettings, manualSpans, excludedSpans],
  );

  const pendingCount = hasResult && applied ? pendingEditCount(applied, current) : 0;

  const effectiveSpans = useMemo<MuteSpan[]>(() => {
    if (!spans) return EMPTY_SPANS;
    if (!applied || !hasResult) return spans;
    return deriveEffectiveSpans({ appliedSpans: spans, applied, current, words });
  }, [spans, applied, hasResult, current, words]);

  // Снимок по свежим значениям: стор и настройки обновляются синхронно,
  // поэтому после правки в том же обработчике видно её результат.
  const capture = useCallback((): MuteEditState => {
    const state = useFetchrMuteStore.getState();
    return editStateFromSettings(getSettings(), state.manualSpans, state.excludedSpans);
  }, [getSettings]);

  const restore = useCallback(
    (state: MuteEditState) => {
      const { setManualSpans, setExcludedSpans } = useFetchrMuteStore.getState();
      setManualSpans(state.manualSpans);
      setExcludedSpans(state.excludedSpans);
      restoreEditValues(state);
    },
    [restoreEditValues],
  );

  // Результат открыт из истории (или вернулись на страницу после анализа,
  // запущенного до этой версии) — файл собран с тем, что сейчас на странице.
  // Снимок, а не `current` из рендера: стор результата и настройки истории
  // приходят разными рендерами, и `current` мог ещё держать прежние словари.
  useEffect(() => {
    if (hasResult && !applied) useFetchrMuteEditsStore.getState().setApplied(capture());
  }, [hasResult, applied, capture]);

  // Действие «Вернуть» текущего тоста сброса: новая правка его закрывает.
  const undoNoticeActionRef = useRef<NoticeAction | null>(null);

  /** Правка результата: меняет текущий набор и попадает в стек отмены. */
  const recordEdit = useCallback(
    (mutate: () => void) => {
      const before = capture();
      mutate();
      if (!useFetchrMuteEditsStore.getState().applied) return;
      if (!editStatesEqual(before, capture())) {
        useFetchrMuteEditsStore.getState().record(before);
        const muteStore = useFetchrMuteStore.getState();
        const undoAction = undoNoticeActionRef.current;
        if (undoAction && muteStore.noticeAction === undoAction) muteStore.setNotice(null);
        undoNoticeActionRef.current = null;
      }
    },
    [capture],
  );

  const undo = useCallback(() => {
    const target = useFetchrMuteEditsStore.getState().undo(capture());
    if (target) restore(target);
  }, [capture, restore]);

  const redo = useCallback(() => {
    const target = useFetchrMuteEditsStore.getState().redo(capture());
    if (target) restore(target);
  }, [capture, restore]);

  const discardPending = useCallback(() => {
    const base = useFetchrMuteEditsStore.getState().applied;
    if (base) recordEdit(() => restore(base));
  }, [recordEdit, restore]);

  /**
   * Уведомление о сбросе с кнопкой «Вернуть»: сброс — отменяемая правка.
   * «Вернуть» привязана к снимку после сброса: если стек отмены с тех пор
   * сдвинулся (новая правка, Ctrl+Z/Ctrl+Y), откатывать уже нечего.
   */
  const notifyUndoable = useCallback(
    (message: string) => {
      const after = capture();
      const depth = useFetchrMuteEditsStore.getState().past.length;
      const action: NoticeAction = {
        label: t("fetchr_mute.notice_undo_action"),
        run: () => {
          undoNoticeActionRef.current = null;
          const unchanged =
            useFetchrMuteEditsStore.getState().past.length === depth &&
            editStatesEqual(after, capture());
          if (unchanged) undo();
        },
      };
      undoNoticeActionRef.current = action;
      useFetchrMuteStore.getState().setNotice(message, action);
    },
    [capture, t, undo],
  );

  /** «Отбросить все» в полосе правок: вернуть набор к применённому, с «Вернуть». */
  const discardPendingWithUndo = useCallback(() => {
    if (!useFetchrMuteEditsStore.getState().applied) return;
    discardPending();
    notifyUndoable(t("fetchr_mute.notice_pending_discarded"));
  }, [discardPending, notifyUndoable, t]);

  /** «Сбросить все правки»: убрать ручные и исключённые отрезки отменяемой правкой. */
  const resetSpanEdits = useCallback(() => {
    const state = useFetchrMuteStore.getState();
    if (state.manualSpans.length === 0 && state.excludedSpans.length === 0) {
      state.setNotice(t("fetchr_mute.notice_no_edits"));
      return;
    }
    recordEdit(() => {
      state.setManualSpans([]);
      state.setExcludedSpans([]);
    });
    notifyUndoable(t("fetchr_mute.notice_edits_reset"));
  }, [recordEdit, notifyUndoable, t]);

  /**
   * Один рендер с полным набором текущих правок. `force` — рендер даже без
   * правок («Сохранить копию» в новый путь).
   */
  const apply = useCallback(
    async (force = false): Promise<RecensorOutcome> => {
      const base = useFetchrMuteEditsStore.getState().applied;
      const snapshot = capture();
      if (!force && (!base || pendingEditCount(base, snapshot) === 0)) return "skipped";
      if (snapshot.censorMethod === "custom" && !snapshot.customSoundPath) {
        useFetchrMuteStore.getState().setError(t("purevoice.custom_sound_required"));
        return "failed";
      }
      return useFetchrMuteStore
        .getState()
        .triggerRecensor(binariesDir, getSettings(), snapshot);
    },
    [binariesDir, capture, getSettings, t],
  );

  /** Перед действием с файлом результата: собрать его с правками, если они есть. */
  const ensureApplied = useCallback(async (): Promise<boolean> => {
    const outcome = await apply();
    return outcome === "applied" || outcome === "skipped";
  }, [apply]);

  return {
    hasResult,
    applied,
    current,
    pendingCount,
    effectiveSpans,
    recordEdit,
    apply,
    ensureApplied,
    discardPending,
    discardPendingWithUndo,
    resetSpanEdits,
    undo,
    redo,
    canUndo: hasResult && canUndo,
    canRedo: hasResult && canRedo,
  };
}

export type PendingEdits = ReturnType<typeof usePendingEdits>;
export type RecordEdit = PendingEdits["recordEdit"];
