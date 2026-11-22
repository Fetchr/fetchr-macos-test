import { useMemo, useState } from "react";

import type { VpsRecordingMeta } from "@/lib/ipc";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { fmtBytes, fmtCount, fmtDuration } from "./format";
import detail from "./RecordingDetail.module.css";
import styles from "./MarkerList.module.css";

/** Подробности записи в меню «…». */
export function RecordingFacts({ recording }: { recording: VpsRecordingMeta }) {
  const gaps = recording.gaps?.length ?? 0;
  return (
    <>
      {recording.available && <span>Размер: {fmtBytes(recording.video_size)}</span>}
      {recording.chat_messages > 0 && <span>{fmtCount(recording.chat_messages)} сообщений в чате</span>}
      {gaps > 0 && <span className={detail.metaWarn}>Разрывов связи: {gaps}</span>}
      {recording.available_start > 0 && <span>Начало до {fmtDuration(recording.available_start)} очищено ротацией</span>}
    </>
  );
}

export function HotkeysInfo() {
  return (
    <>
      <span><kbd className={detail.kbd}>I</kbd> начало клипа · <kbd className={detail.kbd}>O</kbd> конец</span>
      <span><kbd className={detail.kbd}>M</kbd> метка на текущей позиции</span>
      <span><kbd className={detail.kbd}>Shift</kbd> + тянуть по таймлайну — отрезок</span>
      <span>Правый клик по таймлайну — быстрый выбор</span>
      <span><kbd className={detail.kbd}>Ctrl</kbd> + колесо — зум, колесо — листать</span>
      <span><kbd className={detail.kbd}>Ctrl</kbd> + <kbd className={detail.kbd}>K</kbd> — поиск по архиву</span>
    </>
  );
}

interface MarkerListProps {
  recording: VpsRecordingMeta;
  busy: boolean;
  onAdd: (label: string) => void;
  onDelete: (id: string) => void;
  onSeek: (seconds: number) => void;
  onRangeStart: (seconds: number) => void;
  onRangeEnd: (seconds: number) => void;
}

export function MarkerList({ recording, busy, onAdd, onDelete, onSeek, onRangeStart, onRangeEnd }: MarkerListProps) {
  const [label, setLabel] = useState("");
  const markers = useMemo(
    () => [...recording.markers].sort((a, b) => a.timestamp - b.timestamp),
    [recording.markers],
  );
  const add = () => {
    onAdd(label.trim());
    setLabel("");
  };

  return (
    <div className={styles.markers}>
      <div className={styles.markerAdd}>
        <input
          className={detail.field}
          placeholder="Что происходит?"
          value={label}
          maxLength={60}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) add();
          }}
          aria-label="Подпись метки"
        />
        <button type="button" className={styles.markerAddButton} disabled={busy} onClick={add}>
          <RedesignIcon name="add" />
          Метка
        </button>
      </div>

      {markers.length === 0 ? (
        <MarkersEmpty />
      ) : (
        <ul className={styles.markerList}>
          {markers.map((marker) => (
            <li key={marker.id} className={styles.marker}>
              <button
                type="button"
                className={styles.markerMain}
                onClick={() => onSeek(marker.timestamp)}
                title={marker.note ? `${marker.label}
${marker.note}` : marker.label}
              >
                <span className={styles.markerTime}>{fmtDuration(marker.timestamp)}</span>
                <span className={styles.markerText}>
                  <strong>{marker.label}</strong>
                  {marker.note && <small>{marker.note}</small>}
                </span>
              </button>
              <span className={styles.markerActions}>
                <button
                  type="button"
                  className={styles.markerAction}
                  onClick={() => onRangeStart(marker.timestamp)}
                  title="Начать клип с этой метки"
                  aria-label={`Начать клип с метки «${marker.label}»`}
                >
                  Начало
                </button>
                <button
                  type="button"
                  className={styles.markerAction}
                  onClick={() => onRangeEnd(marker.timestamp)}
                  title="Закончить клип на этой метке"
                  aria-label={`Закончить клип на метке «${marker.label}»`}
                >
                  Конец
                </button>
                <button
                  type="button"
                  className={styles.markerAction}
                  onClick={() => onDelete(marker.id)}
                  title="Удалить метку"
                  aria-label={`Удалить метку «${marker.label}»`}
                >
                  <RedesignIcon name="trash" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MarkersEmpty() {
  return (
    <div className={styles.markersEmpty}>
      <span className={styles.markersEmptyIcon} aria-hidden="true">
        <RedesignIcon name="bookmark" />
      </span>
      <p>
        Отмечайте моменты по ходу просмотра: клавиша <kbd className={detail.kbd}>M</kbd> ставит метку там, где сейчас
        плеер. Метки видны на таймлайне, и ротация не стирает кусок рядом с ними.
      </p>
    </div>
  );
}
