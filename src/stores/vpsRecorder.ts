import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { create } from "zustand";
import {
  ipc,
  type VpsAuthMethods,
  type VpsClipMeta,
  type VpsClipProcessingOptions,
  type VpsConfig,
  type VpsManagedState,
  type VpsCredentials,
  type VpsPreflightReport,
  type VpsRecordingMeta,
  type VpsSchedule,
  type VpsStatus,
  type VpsTunnelState,
} from "@/lib/ipc";
import { notifyError, notifySuccess } from "@/lib/notify";
import { clipName, fmtFreed, recordingName } from "@/ui/redesign/vps-recorder/downloadNames";
import { fmtDuration } from "@/ui/redesign/vps-recorder/format";
import {
  armDeleteTimer,
  disarmDeleteTimer,
  isPosterOf,
  newBatchId,
  removeAll,
  reportDeleteResults,
  scheduledMessage,
  undoToastId,
  withoutTombstoned,
  UNDO_MS,
  type VpsDeleteTarget,
  type VpsPendingDelete,
} from "@/ui/redesign/vps-recorder/deleteQueue";
import { keepIfSame, reconcileList } from "@/ui/redesign/vps-recorder/reconcile";
import { friendlyVpsError } from "@/ui/redesign/vps-recorder/vpsErrors";

/** Sections of the archive page a toast action can ask to open. */
export type VpsRequestedSection = "clips" | "server";

export type VpsArchiveSection = "all" | "live" | "withClips" | "clips" | "channels" | "server";

/** What the archive page shows; kept here so it survives leaving the page. */
export interface VpsArchiveView {
  section: VpsArchiveSection;
  channel: string | null;
  query: string;
  picked: string | null;
}

/** Clip range typed or marked for one recording, as timecode strings. */
export interface VpsClipRange {
  start: string;
  end: string;
}

const DEFAULT_VIEW: VpsArchiveView = { section: "all", channel: null, query: "", picked: null };

function goToQueue(): void {
  // Loaded lazily: the router imports this page, which imports this store.
  void import("@/app/router").then(({ router }) => router.navigate({ to: "/queue" }));
}

function notifyQueued(message: string): void {
  toast.success(message, { action: { label: "Перейти в загрузки", onClick: goToQueue } });
}

interface VpsRecorderState {
  config: VpsConfig;
  configLoaded: boolean;
  tunnel: VpsTunnelState;
  preflight: VpsPreflightReport | null;
  authMethods: VpsAuthMethods | null;
  provisionLog: string[];
  connectError: string | null;
  /** Raw backend text behind `connectError`, shown under «Подробнее». */
  connectErrorDetail: string | null;
  /** Reconnect attempts in a row that did not bring the tunnel online. */
  connectFailures: number;
  /** Probes of the Fetchr archive in a row that failed. */
  managedFailures: number;
  /** The last server setup stopped on an error (its last log line failed). */
  provisionFailed: boolean;
  view: VpsArchiveView;
  clipRanges: Record<string, VpsClipRange>;
  /** Section the page should switch to (set by toast actions). */
  requestedSection: VpsRequestedSection | null;
  /** Fetchr archive attached to this machine, and whether it is the shown source. */
  managed: VpsManagedState;
  managedLoaded: boolean;
  /** null until probed. */
  managedOnline: boolean | null;
  managedError: string | null;
  status: VpsStatus | null;
  statusError: string | null;
  clips: VpsClipMeta[];
  recordings: VpsRecordingMeta[];
  /** Первый ответ списка записей уже пришёл (успех или ошибка). */
  recordingsLoaded: boolean;
  schedules: VpsSchedule[];
  posters: Record<string, string>;
  busy: Record<string, boolean>;
  /** Deletes waiting out their «Отменить» window; their items are hidden. */
  pendingDeletes: VpsPendingDelete[];
  unlocked: boolean;
  unlockLoaded: boolean;

  loadConfig: () => Promise<void>;
  saveConfig: (config: VpsConfig) => Promise<boolean>;
  probeAuthMethods: (host: string, port: number, user: string) => Promise<VpsAuthMethods | null>;
  runPreflight: (credentials: VpsCredentials) => Promise<VpsPreflightReport | null>;
  provision: (credentials: VpsCredentials) => Promise<boolean>;
  connect: () => Promise<void>;
  requestSection: (section: VpsRequestedSection | null) => void;
  /** Fresh page visit: automatic reconnects get their full budget again. */
  resetConnectFailures: () => void;
  setView: (patch: Partial<VpsArchiveView>) => void;
  setClipRange: (session: string, patch: Partial<VpsClipRange>) => void;
  loadManaged: () => Promise<void>;
  /** Pull the bought archive from the account. `quiet` is the automatic
   *  attempt when the page opens; `activate` makes it the shown source. */
  connectManaged: (quiet?: boolean, activate?: boolean) => Promise<boolean>;
  /** Switch between the own VPS (false) and the Fetchr archive (true). */
  selectSource: (managed: boolean) => Promise<void>;
  probeManaged: () => Promise<void>;
  forgetManaged: () => Promise<void>;
  disconnect: () => Promise<void>;
  refreshTunnel: () => Promise<void>;
  forget: () => Promise<void>;
  posterFor: (kind: "recording" | "clip", id: string, at?: number) => Promise<string | null>;
  downloadRecording: (
    recording: VpsRecordingMeta,
    directory: string,
    maxConcurrent: number,
    processing?: VpsClipProcessingOptions,
  ) => Promise<void>;
  /** Queues several recordings one by one and reports once. */
  downloadRecordings: (recordings: VpsRecordingMeta[], directory: string, maxConcurrent: number) => Promise<void>;
  setClipKeep: (clipId: string, keep: boolean) => Promise<void>;
  /** Hides the items at once; the server deletes them only after the undo window. */
  scheduleDelete: (targets: VpsDeleteTarget[]) => void;
  undoDelete: (batchId: string) => void;
  /** Runs every waiting delete now (leaving the page, switching servers). */
  flushDeletes: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  refreshClips: () => Promise<void>;
  refreshRecordings: () => Promise<void>;
  refreshSchedules: () => Promise<void>;
  startRecording: (channel: string, title?: string | null) => Promise<boolean>;
  stopRecording: (channel?: string | null) => Promise<void>;
  scheduleRecording: (channel: string, title: string | null, startAt: number, endAt: number | null) => Promise<boolean>;
  deleteSchedule: (scheduleId: string) => Promise<void>;
  saveMarker: (session: string, timestamp: number, label: string, note: string) => Promise<void>;
  deleteMarker: (session: string, markerId: string) => Promise<void>;
  saveClip: (session: string, start: number, end: number, label: string, note: string, tags: string[], accurate: boolean) => Promise<void>;
  downloadClip: (clip: VpsClipMeta, directory: string, maxConcurrent: number, processing?: VpsClipProcessingOptions) => Promise<void>;
  clearBuffer: (withClips: boolean) => Promise<void>;
  loadUnlockStatus: () => Promise<void>;
  unlock: (password: string) => Promise<boolean>;
}

const EMPTY_CONFIG: VpsConfig = {
  host: "",
  ssh_port: 22,
  user: "root",
  agent_port: 8484,
  token: "",
  host_key_fingerprint: "",
  key_path: null,
  base_url: "",
};

const OFFLINE_TUNNEL: VpsTunnelState = {
  phase: "disconnected",
  local_port: null,
  error: null,
  since: null,
};

/** Everything read from one server, dropped when the page switches to the other. */
const SOURCE_RESET = {
  status: null,
  statusError: null,
  recordings: [],
  recordingsLoaded: false,
  clips: [],
  schedules: [],
  posters: {},
};

function queueRecording(recording: VpsRecordingMeta, directory: string, processing: VpsClipProcessingOptions) {
  return ipc.vpsDownloadRecording(
    recording.session,
    recordingName(recording),
    directory,
    recording.channel,
    recording.duration,
    processing,
  );
}

export const useVpsRecorderStore = create<VpsRecorderState>()((set, get) => {
  const dropDeleted = (targets: readonly VpsDeleteTarget[]) => {
    const recordings = new Set(targets.filter((t) => t.kind === "recording").map((t) => t.id));
    const clips = new Set(targets.filter((t) => t.kind === "clip").map((t) => t.id));
    if (recordings.size === 0 && clips.size === 0) return;
    set((s) => ({
      recordings: s.recordings.filter((item) => !recordings.has(item.session)),
      clips: s.clips.filter((item) => !clips.has(item.id)),
      // Poster URLs for them are dead now; drop them so nothing refetches.
      posters: Object.fromEntries(Object.entries(s.posters).filter(([key]) => !isPosterOf(key, recordings, clips))),
    }));
  };

  const startBatch = async (batchId: string): Promise<void> => {
    const batch = get().pendingDeletes.find((item) => item.id === batchId);
    if (!batch || batch.running) return;
    disarmDeleteTimer(batchId);
    set((s) => ({
      pendingDeletes: s.pendingDeletes.map((item) => (item.id === batchId ? { ...item, running: true } : item)),
    }));
    const results = await removeAll(batch.targets);
    dropDeleted(results.filter((result) => result.ok).map((result) => result.target));
    set((s) => ({ pendingDeletes: s.pendingDeletes.filter((item) => item.id !== batchId) }));
    reportDeleteResults(results);
    await get().refreshStatus();
    if (results.some((result) => result.ok && result.target.kind === "clip")) await get().refreshClips();
  };

  return {
  config: EMPTY_CONFIG,
  configLoaded: false,
  tunnel: OFFLINE_TUNNEL,
  preflight: null,
  authMethods: null,
  provisionLog: [],
  connectError: null,
  connectErrorDetail: null,
  connectFailures: 0,
  managedFailures: 0,
  provisionFailed: false,
  view: DEFAULT_VIEW,
  clipRanges: {},
  requestedSection: null,
  managed: { available: false, active: false },
  managedLoaded: false,
  managedOnline: null,
  managedError: null,
  status: null,
  statusError: null,
  clips: [],
  recordings: [],
  recordingsLoaded: false,
  schedules: [],
  posters: {},
  busy: {},
  pendingDeletes: [],
  unlocked: false,
  unlockLoaded: false,

  loadUnlockStatus: async () => {
    try {
      const unlocked = await ipc.vpsUnlockStatus();
      set({ unlocked, unlockLoaded: true });
    } catch {
      set({ unlockLoaded: true });
    }
  },

  unlock: async (password) => {
    try {
      const ok = await ipc.vpsUnlock(password);
      if (ok) {
        set({ unlocked: true, unlockLoaded: true });
      }
      return ok;
    } catch {
      return false;
    }
  },

  loadConfig: async () => {
    try {
      const config = await ipc.vpsGetConfig();
      set({ config, configLoaded: true });
    } catch {
      set({ configLoaded: true });
    }
  },

  saveConfig: async (config) => {
    try {
      await ipc.vpsSetConfig(config);
      set({ config, statusError: null });
      notifySuccess("Настройки VPS сохранены");
      return true;
    } catch (err) {
      notifyError("Не удалось сохранить настройки VPS", err);
      return false;
    }
  },

  probeAuthMethods: async (host, port, user) => {
    set((s) => ({ busy: { ...s.busy, authProbe: true } }));
    try {
      const authMethods = await ipc.vpsAuthMethods(host, port, user);
      set({ authMethods });
      return authMethods;
    } catch {
      // Unreachable host is reported by the connect attempt itself.
      set({ authMethods: null });
      return null;
    } finally {
      set((s) => ({ busy: { ...s.busy, authProbe: false } }));
    }
  },

  runPreflight: async (credentials) => {
    set((s) => ({ busy: { ...s.busy, preflight: true }, connectError: null, connectErrorDetail: null }));
    try {
      const preflight = await ipc.vpsPreflight(credentials);
      set({ preflight });
      return preflight;
    } catch (err) {
      const friendly = friendlyVpsError(err);
      set({ connectError: friendly.message, connectErrorDetail: friendly.detail, preflight: null });
      return null;
    } finally {
      set((s) => ({ busy: { ...s.busy, preflight: false } }));
    }
  },

  provision: async (credentials) => {
    set((s) => ({
      busy: { ...s.busy, provision: true },
      connectError: null,
      connectErrorDetail: null,
      provisionLog: [],
      provisionFailed: false,
    }));
    // Steps arrive while the server is being set up, so a multi-minute install
    // is not a silent spinner.
    const unlisten = await listen<string>("vps-provision-step", (event) => {
      set((s) => ({ provisionLog: [...s.provisionLog, event.payload] }));
    }).catch(() => null);
    try {
      const report = await ipc.vpsProvision(credentials);
      set({ provisionLog: report.log, connectFailures: 0 });
      if (!report.loopback_only) {
        toast.warning(`Порт ${report.agent_port} открыт в интернет`, {
          description:
            `Fetchr работает через защищённый SSH-канал, этот порт снаружи не нужен. Закройте его на сервере: ` +
            `«ufw deny ${report.agent_port}/tcp» (если включён ufw) или ` +
            `«iptables -A INPUT -p tcp --dport ${report.agent_port} -j DROP», либо в фаерволе панели хостинга.`,
          duration: 20000,
        });
      }
      await get().loadConfig();
      await get().refreshTunnel();
      notifySuccess("Сервер подключён и готов к записи");
      return true;
    } catch (err) {
      const friendly = friendlyVpsError(err);
      set({ connectError: friendly.message, connectErrorDetail: friendly.detail, provisionFailed: true });
      return false;
    } finally {
      unlisten?.();
      set((s) => ({ busy: { ...s.busy, provision: false } }));
    }
  },

  connect: async () => {
    set((s) => ({ busy: { ...s.busy, connect: true }, connectError: null, connectErrorDetail: null }));
    try {
      const tunnel = await ipc.vpsConnect();
      set((s) => ({
        tunnel,
        connectFailures: tunnel.phase === "online" ? 0 : s.connectFailures + 1,
      }));
    } catch (err) {
      const friendly = friendlyVpsError(err);
      set((s) => ({
        connectError: friendly.message,
        connectErrorDetail: friendly.detail,
        tunnel: OFFLINE_TUNNEL,
        connectFailures: s.connectFailures + 1,
      }));
    } finally {
      set((s) => ({ busy: { ...s.busy, connect: false } }));
    }
  },

  requestSection: (requestedSection) => set({ requestedSection }),

  resetConnectFailures: () => set({ connectFailures: 0, managedFailures: 0 }),

  setView: (patch) => set((s) => ({ view: { ...s.view, ...patch } })),

  setClipRange: (session, patch) =>
    set((s) => ({
      clipRanges: {
        ...s.clipRanges,
        [session]: { ...(s.clipRanges[session] ?? { start: "", end: "" }), ...patch },
      },
    })),

  loadManaged: async () => {
    try {
      set({ managed: await ipc.vpsManagedState(), managedLoaded: true });
    } catch {
      set({ managedLoaded: true });
    }
  },

  connectManaged: async (quiet = false, activate = true) => {
    set((s) => ({ busy: { ...s.busy, managed: true }, connectError: null, connectErrorDetail: null }));
    try {
      // A waiting delete must reach the server it was made on.
      if (activate) await get().flushDeletes();
      const managed = await ipc.vpsManagedConnect(activate);
      set({ managed, managedOnline: true, managedError: null, managedFailures: 0 });
      if (managed.active) set(SOURCE_RESET);
      if (!quiet) notifySuccess("Архив Fetchr подключён");
      return true;
    } catch (err) {
      if (!quiet) {
        const friendly = friendlyVpsError(err);
        set({ connectError: friendly.message, connectErrorDetail: friendly.detail });
      }
      return false;
    } finally {
      set((s) => ({ busy: { ...s.busy, managed: false } }));
    }
  },

  selectSource: async (useManaged) => {
    try {
      await get().flushDeletes();
      const managed = await ipc.vpsManagedSelect(useManaged);
      set({ managed, ...SOURCE_RESET });
    } catch (err) {
      notifyError("Не удалось переключить сервер", err);
    }
  },

  probeManaged: async () => {
    set((s) => ({ busy: { ...s.busy, probe: true } }));
    try {
      await ipc.vpsManagedProbe();
      set({ managedOnline: true, managedError: null, managedFailures: 0 });
    } catch (err) {
      set((s) => ({
        managedOnline: false,
        managedError: friendlyVpsError(err).message,
        managedFailures: s.managedFailures + 1,
      }));
    } finally {
      set((s) => ({ busy: { ...s.busy, probe: false } }));
    }
  },

  forgetManaged: async () => {
    try {
      await get().flushDeletes();
      const managed = await ipc.vpsManagedForget();
      set({ managed, managedOnline: null, managedError: null, managedFailures: 0, ...SOURCE_RESET });
      notifySuccess("Архив Fetchr отключён от этого компьютера");
    } catch (err) {
      notifyError("Не удалось отключить архив", err);
    }
  },

  disconnect: async () => {
    try {
      await get().flushDeletes();
      const tunnel = await ipc.vpsDisconnect();
      // Poster URLs carry the tunnel port, so they die with the tunnel.
      set({ tunnel, posters: {}, status: null, statusError: null });
    } catch (err) {
      notifyError("Не удалось отключиться от VPS", err);
    }
  },

  refreshTunnel: async () => {
    try {
      set({ tunnel: await ipc.vpsTunnelState() });
    } catch {
      // Tunnel state is advisory; the next status poll surfaces real problems.
    }
  },

  forget: async () => {
    try {
      await get().flushDeletes();
      await ipc.vpsForget();
      set({
        config: EMPTY_CONFIG,
        tunnel: OFFLINE_TUNNEL,
        preflight: null,
        authMethods: null,
        provisionLog: [],
        connectError: null,
        connectErrorDetail: null,
        connectFailures: 0,
        provisionFailed: false,
        status: null,
        recordings: [],
        recordingsLoaded: false,
        clips: [],
        schedules: [],
        posters: {},
      });
      notifySuccess("Данные VPS удалены с этого компьютера");
    } catch (err) {
      notifyError("Не удалось удалить данные VPS", err);
    }
  },

  posterFor: async (kind, id, at = 0) => {
    const key = kind === "clip" ? `clip:${id}` : `rec:${id}:${Math.floor(at)}`;
    const cached = get().posters[key];
    if (cached !== undefined) return cached || null;
    try {
      const url = kind === "clip"
        ? await ipc.vpsClipPosterUrl(id)
        : await ipc.vpsRecordingPosterUrl(id, at);
      set((s) => ({ posters: { ...s.posters, [key]: url } }));
      return url;
    } catch {
      // A session with no closed segment yet simply has no frame to show.
      set((s) => ({ posters: { ...s.posters, [key]: "" } }));
      return null;
    }
  },

  refreshStatus: async () => {
    try {
      const fresh = await ipc.vpsStatus();
      const { status, statusError } = get();
      const next = keepIfSame(status, fresh);
      if (next !== status || statusError !== null) set({ status: next, statusError: null });
    } catch (err) {
      const message = friendlyVpsError(err).message;
      if (get().statusError !== message) set({ statusError: message });
    }
  },

  refreshClips: async () => {
    try {
      const fresh = withoutTombstoned(await ipc.vpsClipsList(), "clip", (clip) => clip.id);
      const clips = reconcileList(get().clips, fresh, (clip) => clip.id);
      if (clips !== get().clips) set({ clips });
    } catch {
      // список клипов не критичен — статус покажет ошибку соединения
    }
  },

  refreshRecordings: async () => {
    try {
      const fresh = withoutTombstoned(await ipc.vpsRecordingsList(), "recording", (item) => item.session);
      const recordings = reconcileList(get().recordings, fresh, (item) => item.session);
      if (recordings !== get().recordings || !get().recordingsLoaded) set({ recordings, recordingsLoaded: true });
    } catch {
      // Status polling reports connectivity errors; keep the last usable archive.
      if (!get().recordingsLoaded) set({ recordingsLoaded: true });
    }
  },

  refreshSchedules: async () => {
    try {
      const schedules = await ipc.vpsSchedulesList();
      set({ schedules });
    } catch {
      // Keep the last schedule snapshot while the VPS is temporarily unavailable.
    }
  },

  startRecording: async (channel, title) => {
    set((s) => ({ busy: { ...s.busy, record: true } }));
    try {
      await ipc.vpsSessionStart(channel, title);
      notifySuccess(`Канал добавлен: ${channel}`, "Сервер начнёт запись, как только канал выйдет в эфир");
      await get().refreshStatus();
      await get().refreshRecordings();
      return true;
    } catch (err) {
      notifyError("Не удалось добавить канал", err);
      return false;
    } finally {
      set((s) => ({ busy: { ...s.busy, record: false } }));
    }
  },

  stopRecording: async (channel) => {
    set((s) => ({ busy: { ...s.busy, record: true } }));
    try {
      await ipc.vpsSessionStop(channel ?? null);
      notifySuccess(channel ? `Канал больше не записывается: ${channel}` : "Запись на VPS остановлена");
      await get().refreshStatus();
      await get().refreshRecordings();
    } catch (err) {
      notifyError("Не удалось остановить запись", err);
    } finally {
      set((s) => ({ busy: { ...s.busy, record: false } }));
    }
  },

  scheduleRecording: async (channel, title, startAt, endAt) => {
    set((s) => ({ busy: { ...s.busy, schedule: true } }));
    try {
      await ipc.vpsScheduleCreate(channel, title, startAt, endAt);
      notifySuccess("Запись добавлена в расписание VPS");
      await get().refreshSchedules();
      return true;
    } catch (err) {
      notifyError("Не удалось создать расписание VPS", err);
      return false;
    } finally {
      set((s) => ({ busy: { ...s.busy, schedule: false } }));
    }
  },

  deleteSchedule: async (scheduleId) => {
    set((s) => ({ busy: { ...s.busy, [`schedule_${scheduleId}`]: true } }));
    try {
      await ipc.vpsScheduleDelete(scheduleId);
      await get().refreshSchedules();
    } catch (err) {
      notifyError("Не удалось отменить запись по расписанию", err);
    } finally {
      set((s) => ({ busy: { ...s.busy, [`schedule_${scheduleId}`]: false } }));
    }
  },

  saveMarker: async (session, timestamp, label, note) => {
    set((s) => ({ busy: { ...s.busy, marker: true } }));
    try {
      await ipc.vpsMarkerAdd(session, timestamp, label || "Метка", note || null);
      notifySuccess(`Метка на ${fmtDuration(timestamp)}`);
      await get().refreshRecordings();
    } catch (err) {
      notifyError("Не удалось сохранить метку", err);
    } finally {
      set((s) => ({ busy: { ...s.busy, marker: false } }));
    }
  },

  deleteMarker: async (session, markerId) => {
    try {
      await ipc.vpsMarkerDelete(session, markerId);
      await get().refreshRecordings();
    } catch (err) {
      notifyError("Не удалось удалить метку", err);
    }
  },

  saveClip: async (session, start, end, label, note, tags, accurate) => {
    set((s) => ({ busy: { ...s.busy, clip: true } }));
    try {
      const clip = await ipc.vpsClipCreate(session, start, end, label || null, note || null, tags, accurate);
      toast.success(`Клип готов: ${fmtDuration(clip.duration)}`, {
        description: clip.chat_messages > 0 ? `Сообщений чата: ${clip.chat_messages}` : undefined,
        action: { label: "Открыть в Клипах", onClick: () => get().requestSection("clips") },
      });
      await get().refreshClips();
    } catch (err) {
      notifyError("Не удалось создать клип", err);
      throw err;
    } finally {
      set((s) => ({ busy: { ...s.busy, clip: false } }));
    }
  },

  downloadClip: async (clip, directory, maxConcurrent, processing = {}) => {
    set((s) => ({ busy: { ...s.busy, [`dl_${clip.id}`]: true } }));
    try {
      await ipc.vpsDownloadClip(clip.id, clipName(clip), directory, clip.channel ?? null, clip.duration, processing);
      await ipc.startQueue(maxConcurrent);
      notifyQueued("Клип добавлен в очередь загрузки");
    } catch (err) {
      notifyError("Не удалось поставить клип в очередь", err);
    } finally {
      set((s) => ({ busy: { ...s.busy, [`dl_${clip.id}`]: false } }));
    }
  },

  downloadRecording: async (recording, directory, maxConcurrent, processing = {}) => {
    const key = `dl_rec_${recording.session}`;
    set((s) => ({ busy: { ...s.busy, [key]: true } }));
    try {
      await queueRecording(recording, directory, processing);
      await ipc.startQueue(maxConcurrent);
      notifyQueued("Запись добавлена в очередь загрузки");
    } catch (err) {
      notifyError("Не удалось поставить запись в очередь", err);
    } finally {
      set((s) => ({ busy: { ...s.busy, [key]: false } }));
    }
  },

  downloadRecordings: async (recordings, directory, maxConcurrent) => {
    if (recordings.length === 0) return;
    set((s) => ({ busy: { ...s.busy, batchDownload: true } }));
    let queued = 0;
    let firstError: unknown = null;
    for (const recording of recordings) {
      try {
        await queueRecording(recording, directory, {});
        queued += 1;
      } catch (err) {
        firstError = firstError ?? err;
      }
    }
    try {
      if (queued > 0) await ipc.startQueue(maxConcurrent);
    } catch (err) {
      firstError = firstError ?? err;
    }
    if (queued > 0) notifyQueued(`В очередь загрузки добавлено записей: ${queued}`);
    if (firstError !== null) {
      toast.error(`Не удалось поставить в очередь ${recordings.length - queued} из ${recordings.length}`, {
        description: friendlyVpsError(firstError).message,
      });
    }
    set((s) => ({ busy: { ...s.busy, batchDownload: false } }));
  },

  setClipKeep: async (clipId, keep) => {
    set((s) => ({ busy: { ...s.busy, [`keep_${clipId}`]: true } }));
    try {
      const updated = await ipc.vpsClipSetKeep(clipId, keep);
      set((s) => ({ clips: s.clips.map((clip) => (clip.id === clipId ? updated : clip)) }));
    } catch (err) {
      notifyError("Не удалось изменить закрепление клипа", err);
    } finally {
      set((s) => ({ busy: { ...s.busy, [`keep_${clipId}`]: false } }));
    }
  },

  scheduleDelete: (targets) => {
    if (targets.length === 0) return;
    const batch: VpsPendingDelete = { id: newBatchId(), targets, running: false };
    set((s) => ({ pendingDeletes: [...s.pendingDeletes, batch] }));
    armDeleteTimer(batch.id, () => void startBatch(batch.id));
    toast(scheduledMessage(targets), {
      id: undoToastId(batch.id),
      duration: UNDO_MS,
      action: { label: "Отменить", onClick: () => get().undoDelete(batch.id) },
    });
  },

  undoDelete: (batchId) => {
    const batch = get().pendingDeletes.find((item) => item.id === batchId);
    if (!batch || batch.running) return;
    disarmDeleteTimer(batchId);
    set((s) => ({ pendingDeletes: s.pendingDeletes.filter((item) => item.id !== batchId) }));
  },

  flushDeletes: async () => {
    const waiting = get().pendingDeletes.filter((batch) => !batch.running);
    await Promise.all(waiting.map((batch) => startBatch(batch.id)));
  },

  clearBuffer: async (withClips) => {
    set((s) => ({ busy: { ...s.busy, clear: true } }));
    try {
      const freed = await ipc.vpsBufferClear(withClips);
      notifySuccess(`На VPS освобождено ${fmtFreed(freed)}`);
      await get().refreshStatus();
      if (withClips) await get().refreshClips();
    } catch (err) {
      notifyError("Не удалось очистить VPS", err);
    } finally {
      set((s) => ({ busy: { ...s.busy, clear: false } }));
    }
  },
};
});
