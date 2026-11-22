import { useState } from "react";

import { notifyError } from "@/lib/notify";
import { useVpsRecorderStore } from "@/stores/vpsRecorder";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { usePersistedState } from "@/hooks/usePersistedState";
import { PlatformIcon } from "@/ui/redesign/icons/iconMap";

import {
  channelLabel,
  fmtDate,
  fmtDuration,
  normalizeChannel,
  VPS_PLATFORMS,
  type VpsPlatform,
} from "./format";
import { ChannelAvatar, ChannelName } from "./ChannelAvatar";
import styles from "./VpsRecorderPage.module.css";

const DEAD_SCHEDULE = new Set(["cancelled", "completed", "expired"]);

const SCHEDULE_STATUS: Record<string, string> = {
  scheduled: "запланировано",
  connecting: "подключаемся",
  waiting_online: "ждём эфир",
  recording: "идёт запись",
  completed: "завершено",
  cancelled: "отменено",
  expired: "истекло",
};

/**
 * Pick a streamer once and the server records every broadcast on its own —
 * Fetchr does not have to be running.
 */
export function WatchTargets() {
  const status = useVpsRecorderStore((s) => s.status);
  const schedules = useVpsRecorderStore((s) => s.schedules);
  const busy = useVpsRecorderStore((s) => s.busy);
  const startRecording = useVpsRecorderStore((s) => s.startRecording);
  const stopRecording = useVpsRecorderStore((s) => s.stopRecording);
  const scheduleRecording = useVpsRecorderStore((s) => s.scheduleRecording);
  const deleteSchedule = useVpsRecorderStore((s) => s.deleteSchedule);
  const ownServer = useVpsRecorderStore((s) => !s.managed.active);

  const [platform, setPlatform] = usePersistedState<VpsPlatform>("fetchr-vps:watchPlatform", "twitch");
  const [channelInput, setChannelInput] = useState("");
  const [title, setTitle] = useState("");
  const [scheduleStart, setScheduleStart] = useState("");
  const [scheduleEnd, setScheduleEnd] = useState("");
  // Destructive buttons arm on the first click, act on the second (as in RecordingList).
  const [armed, setArmed] = useState<string | null>(null);

  const confirmTwice = (key: string, action: () => void) => {
    if (armed !== key) {
      setArmed(key);
      window.setTimeout(() => setArmed((current) => (current === key ? null : current)), 4000);
      return;
    }
    setArmed(null);
    action();
  };

  // Several channels record side by side, each in its own session. `targets`
  // is the list; `target_channel` is only the newest of them, kept for older
  // agents that predate multi-channel recording.
  const targets =
    status?.targets ??
    (status?.target_channel ? [{ channel: status.target_channel, title: status.watch?.title }] : []);
  // Unknown until the server reports it: do not pretend the limit is 1.
  const maxChannels = status?.max_channels ?? null;
  const limitName = ownServer ? "лимит сервера" : "тариф";
  const live = new Map(
    (status?.recordings ?? (status?.recording ? [status.recording] : [])).map((item) => [
      item.channel,
      item,
    ]),
  );
  const atLimit = maxChannels != null && targets.length >= maxChannels;
  const activeSchedules = schedules.filter((schedule) => !DEAD_SCHEDULE.has(schedule.status));
  const channel = normalizeChannel(channelInput, platform);
  const platformInfo = VPS_PLATFORMS.find((item) => item.id === platform) ?? VPS_PLATFORMS[0];
  const alreadyWatched = targets.some((item) => item.channel === channel);
  const watchBlocked = atLimit && !alreadyWatched;
  const limitReason = atLimit
    ? `Достигнут ${limitName}: ${maxChannels} ${maxChannels === 1 ? "канал" : "каналов"} одновременно. Уберите один из списка выше.`
    : null;
  const watchReason = !channel
    ? (limitReason ?? `Укажите ник или ссылку на канал ${platformInfo.label}.`)
    : watchBlocked
      ? limitReason
      : null;
  const scheduleReason = !channel
    ? "Укажите канал в поле «Канал» выше — расписание настраивается для него."
    : !scheduleStart
      ? "Укажите время начала."
      : null;

  const handleWatch = async () => {
    if (!channel) {
      notifyError(`Укажите ник или ссылку на канал ${platformInfo.label}`);
      return;
    }
    if (watchBlocked) {
      notifyError(
        ownServer
          ? `Лимит сервера — ${maxChannels} каналов одновременно`
          : `Больше ${maxChannels} каналов одновременно тариф не позволяет`,
      );
      return;
    }
    if (!(await startRecording(channel, title.trim() || null))) return;
    setChannelInput("");
    setTitle("");
  };

  const handleSchedule = async () => {
    if (!channel) {
      notifyError(`Для расписания нужен ник или ссылка на канал ${platformInfo.label}`);
      return;
    }
    const startAt = new Date(scheduleStart).getTime();
    const endAt = scheduleEnd ? new Date(scheduleEnd).getTime() : null;
    if (!scheduleStart || !Number.isFinite(startAt) || startAt <= Date.now()) {
      notifyError("Укажите будущее время начала записи");
      return;
    }
    if (endAt != null && (!Number.isFinite(endAt) || endAt <= startAt)) {
      notifyError("Время окончания должно быть позже начала");
      return;
    }
    const saved = await scheduleRecording(
      channel,
      title.trim() || null,
      startAt / 1000,
      endAt == null ? null : endAt / 1000,
    );
    if (saved) {
      setScheduleStart("");
      setScheduleEnd("");
    }
  };

  return (
    <>
      <section className={styles.panel}>
        <div>
          <h2 className={styles.panelTitle}>Что записывать</h2>
          <p className={styles.panelHelp}>
            Сервер сам заметит начало эфира и запишет его, даже когда Fetchr закрыт. Если связь
            прервётся, запись продолжится в том же файле. Можно добавить несколько каналов —
            у каждого будут свои записи.
          </p>
        </div>

        {targets.length > 0 && (
          <div className={styles.targetList}>
            {targets.map((target) => {
              const recording = live.get(target.channel);
              return (
                <div key={target.channel} className={styles.targetRow}>
                  <ChannelAvatar channel={target.channel} large />
                  <span className={styles.rowMain}>
                    <strong title={channelLabel(target.channel)}>
                      <ChannelName channel={target.channel} />
                    </strong>
                    {target.title && <small title={target.title}>{target.title}</small>}
                  </span>
                  <span className={`${styles.statusPill} ${recording ? styles.statusRecording : ""}`}>
                    {recording ? (
                      <>
                        <span className={styles.recDot} aria-hidden="true" />
                        {recording.position < 1 ? "подключение…" : fmtDuration(recording.position)}
                      </>
                    ) : (
                      "ждём эфир"
                    )}
                  </span>
                  <button
                    type="button"
                    className={armed === `stop:${target.channel}` ? styles.dangerButton : styles.ghostButton}
                    disabled={busy.record}
                    onClick={() =>
                      confirmTwice(`stop:${target.channel}`, () => void stopRecording(target.channel))
                    }
                    title={
                      recording
                        ? `Остановить запись и больше не следить за ${channelLabel(target.channel)}`
                        : `Больше не следить за ${channelLabel(target.channel)}`
                    }
                  >
                    <RedesignIcon name="stop" />
                    {/* Ширина кнопки — по длинной подписи: второй клик не сдвигает соседей. */}
                    <span className={styles.stableLabel}>
                      <span className={styles.stableLabelSizer} aria-hidden="true">
                        {recording ? "Остановить запись?" : "Больше не записывать?"}
                      </span>
                      <span>
                        {armed === `stop:${target.channel}`
                          ? recording
                            ? "Остановить запись?"
                            : "Больше не записывать?"
                          : "Не записывать"}
                      </span>
                    </span>
                  </button>
                </div>
              );
            })}
            {maxChannels != null && (
              <p className={styles.panelHelp}>
                {atLimit
                  ? `Занято ${targets.length} из ${maxChannels} — это ${limitName}. Уберите один канал, чтобы добавить другой.`
                  : `${targets.length} из ${maxChannels} каналов (${limitName}).`}
              </p>
            )}
          </div>
        )}

        <div className={styles.tabs} role="radiogroup" aria-label="Платформа">
          {VPS_PLATFORMS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={platform === item.id}
              className={`${styles.tab} ${platform === item.id ? styles.tabActive : ""}`}
              onClick={() => setPlatform(item.id)}
            >
              <PlatformIcon platform={item.id} className="size-4" />
              {item.label}
            </button>
          ))}
        </div>

        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Канал {platformInfo.label}</span>
            <input
              className={styles.input}
              value={channelInput}
              onChange={(event) => setChannelInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleWatch();
              }}
              placeholder={platformInfo.placeholder}
              spellCheck={false}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Название (необязательно)</span>
            <input
              className={styles.input}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Как подписать записи"
            />
          </label>
        </div>

        <div className={styles.buttonRow}>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={Boolean(watchReason) || busy.record}
            onClick={() => void handleWatch()}
            aria-busy={busy.record}
            title={watchReason ?? undefined}
            aria-describedby={watchReason ? "vps-watch-reason" : undefined}
          >
            <RedesignIcon
              name={busy.record ? "loading" : "live"}
              className={busy.record ? styles.spinning : undefined}
            />
            {targets.length > 0 ? "Добавить канал" : "Записывать этот канал"}
          </button>
          {watchReason && (channelInput.trim() || atLimit) && (
            <span id="vps-watch-reason" className={styles.panelHelp}>
              {watchReason}
            </span>
          )}
        </div>
      </section>

      <section className={styles.panel}>
        <div>
          <h2 className={styles.panelTitle}>Расписание</h2>
          <p className={styles.panelHelp}>
            Разовая запись к назначенному времени. Если канал ещё офлайн, сервер дождётся эфира.
          </p>
          <p className={styles.panelHelp}>
            Канал:{" "}
            {channel ? <strong>{channelLabel(channel)}</strong> : "не выбран — укажите его в поле «Канал» выше"}
          </p>
        </div>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Начало</span>
            <input
              className={styles.input}
              type="datetime-local"
              value={scheduleStart}
              onChange={(event) => setScheduleStart(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Окончание (необязательно)</span>
            <input
              className={styles.input}
              type="datetime-local"
              value={scheduleEnd}
              onChange={(event) => setScheduleEnd(event.target.value)}
            />
          </label>
        </div>
        <div className={styles.buttonRow}>
          <button
            type="button"
            className={styles.ghostButton}
            disabled={Boolean(scheduleReason) || busy.schedule}
            onClick={() => void handleSchedule()}
            aria-busy={busy.schedule}
            title={scheduleReason ?? undefined}
            aria-describedby={scheduleReason ? "vps-schedule-reason" : undefined}
          >
            <RedesignIcon
              name={busy.schedule ? "loading" : "time"}
              className={busy.schedule ? styles.spinning : undefined}
            />
            Запланировать
          </button>
          {scheduleReason && (
            <span id="vps-schedule-reason" className={styles.panelHelp}>
              {scheduleReason}
            </span>
          )}
        </div>
        {activeSchedules.map((schedule) => (
          <div className={styles.row} key={schedule.id}>
            <span className={styles.rowMain}>
              <strong title={schedule.title || channelLabel(schedule.channel)}>
                {schedule.title || channelLabel(schedule.channel)}
              </strong>
              <small>
                {schedule.title ? `${channelLabel(schedule.channel)} · ` : ""}
                {fmtDate(schedule.start_at)} · {SCHEDULE_STATUS[schedule.status] ?? schedule.status}
              </small>
            </span>
            {armed === `sched:${schedule.id}` ? (
              <button
                type="button"
                className={styles.dangerButton}
                disabled={busy[`schedule_${schedule.id}`]}
                onClick={() => confirmTwice(`sched:${schedule.id}`, () => void deleteSchedule(schedule.id))}
              >
                <RedesignIcon name="trash" />
                Отменить запись?
              </button>
            ) : (
              <button
                type="button"
                className={styles.iconButton}
                disabled={busy[`schedule_${schedule.id}`]}
                onClick={() => confirmTwice(`sched:${schedule.id}`, () => void deleteSchedule(schedule.id))}
                title="Отменить запись по расписанию"
                aria-label="Отменить запись по расписанию"
              >
                <RedesignIcon name="trash" />
              </button>
            )}
          </div>
        ))}
      </section>
    </>
  );
}
