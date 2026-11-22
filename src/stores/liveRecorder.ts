import { create } from "zustand";
import { persist } from "zustand/middleware";
// Live recorder state (markers, saved segments, arming).

export interface ProxySnapshot {
  enabled: boolean;
  url: string;
}

export type ArmStatus = "idle" | "scheduled_pending" | "waiting_online" | "starting";

/** A full snapshot needed to start a live recording later, in the background. */
export interface ArmedRecording {
  id: string;
  url: string;
  name: string;
  directory: string;
  muteSwears: boolean;
  blurSponsors: boolean;
  vocalRemover: boolean;
  recordChatSeparate: boolean;
  twitchAuthToken: string | null;
  /** Proxy settings captured at arm time, so the recording uses the same
   *  network path as the online check. */
  proxy: ProxySnapshot;
  /** "wait_online": start when online. "scheduled": wait until fireAtMs, then online. */
  mode: "wait_online" | "scheduled";
  fireAtMs: number | null;
  /** Runtime progress of the wait (persisted so it survives a restart). */
  status: ArmStatus;
  info: string;
  /** Epoch ms when the last online check started; the card counts down to
   *  the next one from here. Absent until the first check. */
  checkedAt?: number | null;
}

/** Post-processing defaults chosen in the form at arm time; the watcher copies
 *  them onto the created job so the job card toggles start in the right state. */
export interface LiveJobDefaults {
  muteSwears: boolean;
  blurSponsors: boolean;
  vocalRemover: boolean;
  recordChatSeparate: boolean;
}

/** Manual chronology marker placed by the user during a live recording. */
export interface LiveMarker {
  id: string;
  /** Seconds from the recording start. */
  t: number;
  label: string;
}

/** A segment already saved from a live recording (for the chronology list). */
export interface SavedSegment {
  fileName: string;
  label: string;
  startSec: number;
  endSec: number;
  savedAtMs: number;
}

interface LiveRecorderState {
  // Background pre-arm / scheduled recordings (driven by a global watcher so
  // they keep running regardless of which tab is open). Several streams can be
  // armed at once; the list is persisted and resumes after an app restart.
  armed: ArmedRecording[];
  addArmed: (armed: ArmedRecording) => void;
  updateArmed: (id: string, patch: Partial<ArmedRecording>) => void;
  removeArmed: (id: string) => void;

  /** jobId -> post-processing defaults captured when the job was armed. */
  jobDefaults: Record<string, LiveJobDefaults>;
  setJobDefaults: (jobId: string, defaults: LiveJobDefaults) => void;

  url: string;
  name: string;
  splittingJobIds: Record<string, boolean>;
  /** jobId -> chronological list of saved segments. */
  savedSegments: Record<string, SavedSegment[]>;
  /** jobId -> manual markers. */
  markers: Record<string, LiveMarker[]>;
  activePreviewJobId: string | null;
  muteSwears: boolean;
  blurSponsors: boolean;
  vocalRemover: boolean;
  recordChatSeparate: boolean;
  setUrl: (url: string) => void;
  setName: (name: string) => void;
  setSplitting: (id: string, splitting: boolean) => void;
  addSavedSegment: (jobId: string, segment: SavedSegment) => void;
  addMarker: (jobId: string, t: number, label: string) => void;
  renameMarker: (jobId: string, markerId: string, label: string) => void;
  removeMarker: (jobId: string, markerId: string) => void;
  setActivePreviewJobId: (id: string | null) => void;
  setMuteSwears: (val: boolean) => void;
  setBlurSponsors: (val: boolean) => void;
  setVocalRemover: (val: boolean) => void;
  setRecordChatSeparate: (val: boolean) => void;
}

export const useLiveRecorderStore = create<LiveRecorderState>()(
  persist(
    (set) => ({
      armed: [],
      addArmed: (armed) => set((s) => ({ armed: [...s.armed, armed] })),
      updateArmed: (id, patch) =>
        set((s) => ({
          armed: s.armed.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        })),
      removeArmed: (id) => set((s) => ({ armed: s.armed.filter((a) => a.id !== id) })),

      jobDefaults: {},
      setJobDefaults: (jobId, defaults) =>
        set((s) => ({ jobDefaults: { ...s.jobDefaults, [jobId]: defaults } })),

      url: "",
      name: "",
      splittingJobIds: {},
      savedSegments: {},
      markers: {},
      activePreviewJobId: null,
      muteSwears: false,
      blurSponsors: false,
      vocalRemover: false,
      recordChatSeparate: false,
      setUrl: (url) => set({ url }),
      setName: (name) => set({ name }),
      setSplitting: (id, splitting) =>
        set((s) => ({
          splittingJobIds: {
            ...s.splittingJobIds,
            [id]: splitting,
          },
        })),
      addSavedSegment: (jobId, segment) =>
        set((s) => {
          const parts = s.savedSegments[jobId] || [];
          if (parts.some((p) => p.fileName === segment.fileName)) return {};
          const next = [...parts, segment].sort((a, b) => a.startSec - b.startSec);
          return { savedSegments: { ...s.savedSegments, [jobId]: next } };
        }),
      addMarker: (jobId, t, label) =>
        set((s) => {
          const list = s.markers[jobId] || [];
          const marker: LiveMarker = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            t: Math.max(0, Math.floor(t)),
            label,
          };
          const next = [...list, marker].sort((a, b) => a.t - b.t);
          return { markers: { ...s.markers, [jobId]: next } };
        }),
      renameMarker: (jobId, markerId, label) =>
        set((s) => {
          const list = s.markers[jobId] || [];
          return {
            markers: {
              ...s.markers,
              [jobId]: list.map((m) => (m.id === markerId ? { ...m, label } : m)),
            },
          };
        }),
      removeMarker: (jobId, markerId) =>
        set((s) => {
          const list = s.markers[jobId] || [];
          return {
            markers: {
              ...s.markers,
              [jobId]: list.filter((m) => m.id !== markerId),
            },
          };
        }),
      setActivePreviewJobId: (activePreviewJobId) => set({ activePreviewJobId }),
      setMuteSwears: (muteSwears) => set({ muteSwears }),
      setBlurSponsors: (blurSponsors) => set({ blurSponsors }),
      setVocalRemover: (vocalRemover) => set({ vocalRemover }),
      setRecordChatSeparate: (recordChatSeparate) => set({ recordChatSeparate }),
    }),
    {
      name: "fetchr-live-recorder",
      version: 1,
      // Runtime-only fields (preview session, in-flight split flags) are not
      // persisted; everything else survives an app restart.
      partialize: (s) => ({
        armed: s.armed.map((a) =>
          a.status === "starting" ? { ...a, status: "waiting_online" as ArmStatus } : a,
        ),
        jobDefaults: s.jobDefaults,
        url: s.url,
        name: s.name,
        savedSegments: s.savedSegments,
        markers: s.markers,
        muteSwears: s.muteSwears,
        blurSponsors: s.blurSponsors,
        vocalRemover: s.vocalRemover,
        recordChatSeparate: s.recordChatSeparate,
      }),
    },
  ),
);
