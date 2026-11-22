import { useEffect, useRef } from "react";

import { ipc } from "@/lib/ipc";
import { notifySuccess } from "@/lib/notify";
import { detectPlatform } from "@/lib/url";
import { useSettings } from "@/stores/settings";
import { useQueue } from "@/stores/queue";
import { useLiveRecorderStore, type ArmedRecording } from "@/stores/liveRecorder";

/** Normalize a stream URL so the same stream entered twice is detected. */
export function normalizeStreamUrl(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

type OnlineCheck = { online: boolean; error: string | null };

async function checkStreamOnline(
  url: string,
  token: string | null,
  proxy: ArmedRecording["proxy"],
): Promise<OnlineCheck> {
  try {
    const { binariesDir } = useSettings.getState();
    const resolved = await ipc.resolveStream(url, proxy, binariesDir, token);
    return { online: Boolean(resolved.is_live), error: null };
  } catch (err) {
    return { online: false, error: String((err as any)?.message ?? err) };
  }
}

function buildLiveSpec(armed: ArmedRecording) {
  return {
    url: armed.url,
    name: armed.name,
    directory: armed.directory,
    mode: "live" as const,
    // Quality selection was removed from the UI: live recordings always grab
    // the source ("best"); the real quality is probed and shown after start.
    quality: "best",
    split: false,
    unmute_video: false,
    proxy: armed.proxy,
    meta: { platform: detectPlatform(armed.url), title: armed.name },
    twitch_auth_token: armed.twitchAuthToken,
    fragments: [],
    blur_zones: [],
    fetchr_mute_enabled: armed.muteSwears,
    fetchr_mute_settings: {
      language: "ru" as const,
      mode: "normal" as const,
      asr_model: "gigaam_v3_rnnt_int8" as const,
      censorship_level: "standard" as const,
      censor_method: "mute" as const,
      mute_profile: "adaptive" as const,
      coverage_percent: 70,
      fade_out_ms: 100,
      fade_in_ms: 5,
      min_mute_ms: 80,
      custom_words: [],
      whitelist_words: [],
      only_custom_words: false,
      smooth_mute: true,
      custom_sound_path: null,
    },
    vocal_remover_enabled: armed.vocalRemover,
    vocal_remover_settings: armed.vocalRemover
      ? { mode: "fast_htdemucs" as const, workflow: "anti_copyright" as const }
      : null,
    record_chat_separate: armed.recordChatSeparate,
  };
}

/** A recording of the same URL is already in the queue (e.g. enqueued before
 *  an app restart, or started manually from another page). */
function findExistingLiveJob(url: string) {
  const wanted = normalizeStreamUrl(url);
  return useQueue
    .getState()
    .jobs.find(
      (j) =>
        j.spec.mode === "live" &&
        (j.status === "running" || j.status === "queued") &&
        normalizeStreamUrl(j.spec.url) === wanted,
    );
}

interface ArmedRuntime {
  lastCheck: number;
  checking: boolean;
  /** Set once enqueueJob succeeded; a retry then only (re)starts the queue
   *  instead of enqueueing a duplicate recording. */
  enqueuedId: string | null;
}

/**
 * Drives background pre-arm / scheduled live recordings. Mounted once at the app
 * root so it keeps polling regardless of the active tab. Nothing is recorded
 * while the stream is offline; it polls every 5 seconds and starts as soon as
 * the stream goes live (after the scheduled time, when one is set).
 */
export function useScheduledRecordingWatcher() {
  const armed = useLiveRecorderStore((s) => s.armed);
  const updateArmed = useLiveRecorderStore((s) => s.updateArmed);
  const removeArmed = useLiveRecorderStore((s) => s.removeArmed);
  const setJobDefaults = useLiveRecorderStore((s) => s.setJobDefaults);
  const runtimeRef = useRef<Record<string, ArmedRuntime>>({});

  useEffect(() => {
    if (armed.length === 0) return;
    let cancelled = false;

    const runtimeFor = (id: string): ArmedRuntime => {
      const map = runtimeRef.current;
      if (!map[id]) map[id] = { lastCheck: 0, checking: false, enqueuedId: null };
      return map[id];
    };

    const setStatus = (
      item: ArmedRecording,
      status: ArmedRecording["status"],
      info: string,
      checkedAt: number | null = item.checkedAt ?? null,
    ) => {
      if (item.status === status && item.info === info && (item.checkedAt ?? null) === checkedAt) return; // avoid useless persist writes
      updateArmed(item.id, { status, info, checkedAt });
    };

    const finishArmed = (item: ArmedRecording, jobId: string | null) => {
      if (jobId) {
        setJobDefaults(jobId, {
          muteSwears: item.muteSwears,
          blurSponsors: item.blurSponsors,
          vocalRemover: item.vocalRemover,
          recordChatSeparate: item.recordChatSeparate,
        });
      }
      notifySuccess(`${item.name || item.url} в эфире`, "Запись началась автоматически");
      removeArmed(item.id);
      delete runtimeRef.current[item.id];
    };

    const startArmedRecording = async (item: ArmedRecording, rt: ArmedRuntime) => {
      // If enqueue previously succeeded but startQueue failed, only retry the
      // queue start — never enqueue a duplicate.
      if (rt.enqueuedId) {
        await ipc.startQueue(useSettings.getState().maxConcurrentJobs);
        if (!cancelled) finishArmed(item, rt.enqueuedId);
        return;
      }
      const existing = findExistingLiveJob(item.url);
      if (existing) {
        if (!cancelled) finishArmed(item, existing.id);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const job = await ipc.enqueueJob(buildLiveSpec(item) as any);
      rt.enqueuedId = job?.id ?? null;
      await ipc.startQueue(useSettings.getState().maxConcurrentJobs);
      if (!cancelled) finishArmed(item, rt.enqueuedId);
    };

    const tickItem = async (item: ArmedRecording) => {
      const rt = runtimeFor(item.id);
      if (cancelled || rt.checking) return;
      const now = Date.now();

      // Hold until the scheduled time, if any.
      if (item.mode === "scheduled" && item.fireAtMs && now < item.fireAtMs) {
        setStatus(
          item,
          "scheduled_pending",
          `Запланировано на ${new Date(item.fireAtMs).toLocaleString()}`,
        );
        return;
      }

      // Throttle the online check to once every 5 seconds.
      if (now - rt.lastCheck < 5000) return;
      rt.lastCheck = now;
      rt.checking = true;
      try {
        const { online, error } = await checkStreamOnline(
          item.url,
          item.twitchAuthToken,
          item.proxy,
        );
        if (cancelled) return;
        if (online) {
          setStatus(item, "starting", "Онлайн — запускаю запись…", now);
          await startArmedRecording(item, rt);
        } else if (error) {
          setStatus(
            item,
            "waiting_online",
            `Не удалось проверить стрим (${error}) — повторю через 5 c…`,
            now,
          );
        } else {
          setStatus(
            item,
            "waiting_online",
            `Оффлайн (проверено ${new Date().toLocaleTimeString()}) — жду онлайна…`,
            now,
          );
        }
      } catch (err) {
        if (!cancelled) {
          setStatus(
            item,
            "waiting_online",
            `Ошибка запуска: ${String((err as any)?.message ?? err)} — повторю через 5 c…`,
            now,
          );
        }
      } finally {
        rt.checking = false;
      }
    };

    const tick = () => {
      for (const item of useLiveRecorderStore.getState().armed) {
        void tickItem(item);
      }
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [armed.length, updateArmed, removeArmed, setJobDefaults]);
}
