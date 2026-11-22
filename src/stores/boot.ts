import { create } from "zustand";

import { ipc, type BetaActivationLink, type LicenseStatus } from "@/lib/ipc";
import { useUpdater } from "@/stores/updater";

/**
 * Фаза запуска.
 *
 * checking   — лицензия и обновления проверяются параллельно;
 * updating   — качается и ставится обновление (при запуске или из приложения);
 * activation — ключ недействителен или пробная загрузка уже сделана, нужна активация;
 * ready      — приложение открыто, заставка ушла в топбар.
 */
export type BootPhase = "checking" | "updating" | "activation" | "ready";

export type BootTaskState = "pending" | "done" | "failed";

interface BootState {
  phase: BootPhase;
  /** Однажды пропущенное приложение остаётся смонтированным под заставкой обновления */
  unlocked: boolean;
  /** Заставка доиграла уход: можно показывать то, что ждало интро (тур) */
  settled: boolean;
  licenseTask: BootTaskState;
  updateTask: BootTaskState;
  license: LicenseStatus | null;
  activationLink: BetaActivationLink | null;
  licenseError: string | null;
  licenseBusy: boolean;
  /** Версия до обновления, если с прошлого запуска она сменилась */
  updatedFrom: string | null;
  /** Первый запуск этой версии: после установки или обновления */
  freshVersion: boolean;
  /** Ключа нет, но первая загрузка ещё не сделана: приложение открыто без активации */
  trial: boolean;
  /** Пробная загрузка завершилась — активацию показывают с этим поводом */
  trialEnded: boolean;

  start: () => void;
  activate: (key: string) => Promise<void>;
  recheckLicense: () => Promise<void>;
  startUpdate: () => void;
  leaveUpdate: () => void;
  markSettled: () => void;
  /** Задача завершилась успешно: в пробном режиме пора активировать */
  noteJobDone: () => void;
}

const LAST_VERSION_KEY = "fetchr-last-version";
const TRIAL_USED_KEY = "fetchr-trial-used";

function trialUsed(): boolean {
  try {
    return localStorage.getItem(TRIAL_USED_KEY) === "1";
  } catch {
    return false;
  }
}

function markTrialUsed() {
  try {
    localStorage.setItem(TRIAL_USED_KEY, "1");
  } catch {
    // без хранилища пробный режим кончится вместе с сеансом
  }
}

let started = false;

export const useBoot = create<BootState>((set, get) => {
  const setPhase = (phase: BootPhase) =>
    set((state) => ({
      phase,
      unlocked: state.unlocked || phase === "ready",
      settled: phase === "ready" ? state.settled : false,
    }));

  /** Ключа ещё не было и первая загрузка не сделана. Недействительный или
   *  отозванный ключ пробы не даёт: приложение у человека уже работало. */
  const trialAvailable = () => get().license?.state === "missing" && !trialUsed() && !get().trialEnded;

  /** Куда идти, когда ничего не устанавливается */
  const restingPhase = (): BootPhase => {
    const state = get();
    if (state.trialEnded && state.license?.state !== "active") return "activation";
    if (state.unlocked) return "ready";
    if (state.licenseTask === "pending") return "checking";
    if (state.license?.state === "active") return "ready";
    if (trialAvailable()) {
      set({ trial: true });
      return "ready";
    }
    return "activation";
  };

  const loadLicense = async () => {
    try {
      const [license, activationLink] = await Promise.all([
        ipc.licenseStatus(),
        ipc.betaActivationLink(),
      ]);
      set({
        license,
        activationLink,
        licenseTask: "done",
        licenseError: license.state === "invalid" ? license.message : null,
      });
    } catch (error) {
      set({ licenseTask: "failed", licenseError: String(error) });
    }
  };

  return {
    phase: "checking",
    unlocked: false,
    settled: false,
    licenseTask: "pending",
    updateTask: "pending",
    license: null,
    activationLink: null,
    licenseError: null,
    licenseBusy: false,
    updatedFrom: null,
    freshVersion: false,
    trial: false,
    trialEnded: false,

    start: () => {
      if (started) return;
      started = true;
      set(rememberVersion());

      const license = loadLicense();
      const update = useUpdater
        .getState()
        .check()
        .then((status) => {
          set({ updateTask: status ? "done" : "failed" });
          // Лаунчер-режим: найденное обновление ставится сразу, не дожидаясь
          // лицензии. Только то, что бэкенд примет: иначе, например на macOS,
          // каждый запуск заканчивался бы карточкой сбоя.
          if (status?.available && status.installable) get().startUpdate();
        });

      void Promise.allSettled([license, update]).then(() => {
        if (get().phase === "checking") setPhase(restingPhase());
      });
    },

    activate: async (key) => {
      set({ licenseBusy: true, licenseError: null });
      try {
        const license = await ipc.activateLicense(key);
        set({ license, licenseTask: "done" });
        if (license.state === "active") set({ trial: false, trialEnded: false });
        if (license.state === "active" && get().phase === "activation") setPhase("ready");
      } catch (error) {
        set({ licenseError: String(error) });
      } finally {
        set({ licenseBusy: false });
      }
    },

    recheckLicense: async () => {
      set({ licenseBusy: true, licenseError: null });
      await loadLicense();
      set({ licenseBusy: false });
      if (get().license?.state === "active") set({ trial: false, trialEnded: false });
      if (get().phase === "activation" && get().license?.state === "active") setPhase("ready");
    },

    startUpdate: () => {
      setPhase("updating");
      void useUpdater
        .getState()
        .install()
        .then((outcome) => {
          // Неудачу заставка показывает сама и ждёт решения: повторить или продолжить.
          if (outcome === "cancelled") get().leaveUpdate();
        });
    },

    leaveUpdate: () => {
      useUpdater.getState().reset();
      if (get().phase === "updating") setPhase(restingPhase());
    },

    // Уход мог доиграть уже после нового запроса обновления — тогда рано.
    markSettled: () => {
      if (get().phase === "ready") set({ settled: true });
    },

    // Задача доиграет до конца — файл у человека есть, дальше нужен ключ.
    // Идущее обновление не прерываем: активация поднимется после него.
    noteJobDone: () => {
      if (!get().trial) return;
      markTrialUsed();
      set({ trial: false, trialEnded: true });
      if (get().phase === "ready") setPhase("activation");
    },
  };
});

/**
 * Запоминает текущую версию. updatedFrom — прошлая, если она отличалась;
 * freshVersion — эту версию запускают впервые (установка или обновление).
 */
function rememberVersion(): Pick<BootState, "updatedFrom" | "freshVersion"> {
  try {
    const previous = localStorage.getItem(LAST_VERSION_KEY);
    localStorage.setItem(LAST_VERSION_KEY, __APP_VERSION__);
    return {
      updatedFrom: previous && previous !== __APP_VERSION__ ? previous : null,
      freshVersion: previous !== __APP_VERSION__,
    };
  } catch {
    return { updatedFrom: null, freshVersion: false };
  }
}
