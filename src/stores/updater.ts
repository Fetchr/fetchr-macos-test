import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  ipc,
  onUpdateProgress,
  UPDATE_CANCELLED,
  type UpdateProgress,
  type UpdateStatus,
} from "@/lib/ipc";

/** preparing — бэкенд перепроверяет манифест, байтов ещё нет */
export type UpdateStage = "idle" | "preparing" | "downloading" | "verifying" | "installing" | "failed";

/** Установка удалась — процесс завершается, поэтому промис отвечает только о неудаче */
export type InstallOutcome = "cancelled" | "failed";

interface UpdaterState {
  status: UpdateStatus | null;
  checking: boolean;
  checkError: string | null;
  stage: UpdateStage;
  received: number;
  total: number | null;
  bytesPerSecond: number;
  installError: string | null;
  cancelling: boolean;

  check: () => Promise<UpdateStatus | null>;
  install: () => Promise<InstallOutcome>;
  cancel: () => void;
  reset: () => void;
}

type SetState = (partial: Partial<UpdaterState>) => void;
type GetState = () => UpdaterState;

const STAGE_BY_PHASE: Record<UpdateProgress["phase"], UpdateStage> = {
  download: "downloading",
  verify: "verifying",
  install: "installing",
};

// Запуск и карточка настроек могут спросить одновременно — хватит одного запроса.
let pendingCheck: Promise<UpdateStatus | null> | null = null;
let pendingInstall: Promise<InstallOutcome> | null = null;
/**
 * Id попытки: отмена привязана к нему, а не к флагу. «Позже», нажатая до
 * того, как бэкенд принял установку, всё равно сработает, а старый клик не
 * отменит следующую попытку. Время в основе — id не повторяются и после
 * перезагрузки страницы.
 */
let lastAttempt = Date.now();
let currentAttempt = 0;

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: null,
  checking: false,
  checkError: null,
  stage: "idle",
  received: 0,
  total: null,
  bytesPerSecond: 0,
  installError: null,
  cancelling: false,

  check: () => {
    if (pendingCheck) return pendingCheck;
    set({ checking: true, checkError: null });
    pendingCheck = ipc
      .checkForUpdate()
      .then((status) => {
        set({ status });
        return status;
      })
      .catch((error: unknown) => {
        set({ checkError: String(error) });
        return null;
      })
      .finally(() => {
        set({ checking: false });
        pendingCheck = null;
      });
    return pendingCheck;
  },

  install: () => {
    if (pendingInstall) return pendingInstall;
    lastAttempt += 1;
    currentAttempt = lastAttempt;
    set({
      stage: "preparing",
      received: 0,
      total: get().status?.size_bytes ?? null,
      bytesPerSecond: 0,
      installError: null,
      cancelling: false,
    });
    pendingInstall = runInstall(currentAttempt, set, get).finally(() => {
      pendingInstall = null;
    });
    return pendingInstall;
  },

  cancel: () => {
    if (get().cancelling || !pendingInstall) return;
    set({ cancelling: true });
    void ipc.cancelUpdate(currentAttempt).catch(() => set({ cancelling: false }));
  },

  reset: () =>
    set({ stage: "idle", installError: null, received: 0, bytesPerSecond: 0, cancelling: false }),
}));

async function runInstall(attempt: number, set: SetState, get: GetState): Promise<InstallOutcome> {
  let unlisten: UnlistenFn | null = null;
  const cancelled = (): InstallOutcome => {
    set({ stage: "idle", cancelling: false });
    return "cancelled";
  };
  try {
    unlisten = await onUpdateProgress((progress) =>
      set({
        stage: STAGE_BY_PHASE[progress.phase],
        received: progress.received,
        total: progress.total,
        bytesPerSecond: progress.bytes_per_second,
      }),
    );
    if (get().cancelling) return cancelled();
    await ipc.installUpdate(attempt);
    // Сюда доходим, только если бэкенд вернулся без перезапуска.
    set({ stage: "failed", installError: null, cancelling: false });
    return "failed";
  } catch (error) {
    // После «Позже» любой обрыв — это уже отмена, а не сбой.
    if (String(error) === UPDATE_CANCELLED || get().cancelling) return cancelled();
    set({ stage: "failed", installError: String(error), cancelling: false });
    return "failed";
  } finally {
    unlisten?.();
  }
}
