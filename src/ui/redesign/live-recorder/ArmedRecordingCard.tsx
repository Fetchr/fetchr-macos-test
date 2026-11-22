import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { detectPlatform } from "@/lib/url";
import type { ArmedRecording } from "@/stores/liveRecorder";
import { PlatformIcon, RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./LiveRecorderPage.module.css";

/** Шаг проверки эфира — тот же, что у useScheduledRecordingWatcher */
const CHECK_INTERVAL_MS = 5000;

interface ArmedRecordingCardProps {
  armed: ArmedRecording;
  onCancel: (id: string) => void;
}

/**
 * Запись, которая ждёт эфира. Радар вокруг значка трансляции показывает,
 * что Fetchr слушает канал, а счётчик — когда будет следующая проверка:
 * так ожидание видно глазом, а не только по надписи.
 */
export function ArmedRecordingCard({ armed, onCancel }: ArmedRecordingCardProps) {
  const { t } = useTranslation();
  const platform = detectPlatform(armed.url);
  const scheduled = armed.status === "scheduled_pending";

  return (
    <article className={cn(styles.recordingCard, styles.recordingCardArmed)} data-platform={platform}>
      <div className={styles.armedHeader}>
        <div className={cn(styles.radar, scheduled && styles.radarPaused)} data-platform={platform} aria-hidden>
          <span className={styles.radarRing} />
          <span className={styles.radarRing} />
          <RedesignIcon name="live" className={styles.radarIcon} />
        </div>
        <div className={styles.cardHeader}>
          <div className={styles.cardMeta}>
            <h3 className={styles.cardTitle}>{armed.name || armed.url}</h3>
            <span className={styles.cardUrl}>{armed.url}</span>
            <span className={styles.armedCheck}>
              <RedesignIcon name={scheduled ? "time" : "refresh"} className={styles.armedCheckIcon} />
              {scheduled ? armed.info : <NextCheckCountdown checkedAt={armed.checkedAt ?? null} />}
            </span>
          </div>
          <div className={styles.cardBadges}>
            <span className={cn(styles.badge, styles.platformBadge)} data-platform={platform}>
              <PlatformIcon platform={platform} className="size-3" />
              {platform}
            </span>
            <span className={cn(styles.badge, styles.statusBadge, styles.statusQueued)}>
              {t("live_recorder.ozhidanie", "ОЖИДАНИЕ")}
            </span>
          </div>
        </div>
      </div>

      <div className={styles.statsGrid}>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t("live_recorder.status", "Статус")}</span>
          <span className={styles.statValue}>{scheduled ? "По расписанию" : "Жду онлайна"}</span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t("live_recorder.proverka", "Проверка")}</span>
          <span className={styles.statValue}>{t("live_recorder.kazhdye_5_c", "каждые 5 c")}</span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t("live_recorder.kachestvo", "Качество")}</span>
          <span className={styles.statValue}>{t("live_recorder.istochnik", "Источник")}</span>
        </div>
        <div className={styles.statPill}>
          <span className={styles.statLabel}>{t("live_recorder.chat", "Чат")}</span>
          <span className={styles.statValue}>{armed.recordChatSeparate ? "JSON" : "Выкл"}</span>
        </div>
      </div>

      <div className={styles.cardActions}>
        <p className={styles.sectionHelp}>{!scheduled && armed.info ? armed.info : ""}</p>
        <button type="button" className={styles.actionButton} onClick={() => onCancel(armed.id)}>
          <RedesignIcon name="close" className="size-3.5" />
          {t("live_recorder.otmenit_ozhidanie", "Отменить ожидание")}
        </button>
      </div>
    </article>
  );
}

/** «Проверка через N с»: счёт от начала прошлой проверки, раз в секунду */
function NextCheckCountdown({ checkedAt }: { checkedAt: number | null }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (checkedAt == null) return <>{t("live_recorder.checking_now", "Проверяю эфир…")}</>;
  const seconds = Math.ceil((checkedAt + CHECK_INTERVAL_MS - now) / 1000);
  if (seconds <= 0) return <>{t("live_recorder.checking_now", "Проверяю эфир…")}</>;
  return (
    <>
      {t("live_recorder.next_check_in", "Проверка через")}{" "}
      <b className={styles.armedCountdown}>{t("live_recorder.seconds_short", "{{count}} с", { count: seconds })}</b>
    </>
  );
}
