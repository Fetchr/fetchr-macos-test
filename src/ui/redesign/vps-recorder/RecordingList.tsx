import { memo, useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";

import type { VpsRecordingMeta } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";
import { useVpsRecorderStore } from "@/stores/vpsRecorder";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { groupByDay, isLive, isWaiting, recordingTitle, timeOf } from "./archiveModel";
import { BatchBar } from "./BatchBar";
import { channelLabel, fmtBytes, fmtDuration } from "./format";
import { PosterImage } from "./PosterImage";
import styles from "./RecordingList.module.css";
import { useRecordingSelection } from "./useRecordingSelection";

/** Строки появляются лесенкой только при первом показе и не больше восьми. */
const INTRO_ROWS = 8;
const INTRO_MS = 600;
const SKELETON_ROWS = Array.from({ length: 6 }, (_, index) => index);
const SKELETON_STEP_MS = 80;

interface RecordingListProps {
  title: string;
  recordings: VpsRecordingMeta[];
  clipCounts: Map<string, number>;
  selected: string | null;
  onSelect: (session: string) => void;
  emptyText: string;
  /** Список ещё ни разу не пришёл с сервера: вместо «пусто» — скелетон. */
  loading?: boolean;
}

function deleteTarget(recording: VpsRecordingMeta) {
  return { kind: "recording" as const, id: recording.session, title: recordingTitle(recording) };
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || Boolean(element?.isContentEditable);
}

function useIntro(hasRows: boolean): boolean {
  const [intro, setIntro] = useState(true);
  useEffect(() => {
    if (!intro || !hasRows) return;
    const timer = window.setTimeout(() => setIntro(false), INTRO_MS);
    return () => window.clearTimeout(timer);
  }, [intro, hasRows]);
  return intro;
}

/** Библиотека слева: записи по дням, идущие эфиры сверху. Поиск и фильтры — в командной строке. */
export function RecordingList({ title, recordings, clipCounts, selected, onSelect, emptyText, loading = false }: RecordingListProps) {
  const groups = useMemo(() => groupByDay(recordings), [recordings]);
  // Идущий эфир не удалить, поэтому галочки только у законченных записей.
  const selectable = useMemo(() => recordings.filter((recording) => !isLive(recording)), [recordings]);
  const selection = useRecordingSelection(selectable);
  const scheduleDelete = useVpsRecorderStore((s) => s.scheduleDelete);
  const downloadRecording = useVpsRecorderStore((s) => s.downloadRecording);
  const directory = useSettings((state) => state.directory);
  const maxConcurrentJobs = useSettings((state) => state.maxConcurrentJobs);
  const intro = useIntro(recordings.length > 0);
  const order = useMemo(() => new Map(recordings.map((recording, index) => [recording.session, index])), [recordings]);

  const deleteOne = useCallback(
    (recording: VpsRecordingMeta) => scheduleDelete([deleteTarget(recording)]),
    [scheduleDelete],
  );
  const downloadOne = useCallback(
    (recording: VpsRecordingMeta) => void downloadRecording(recording, directory, maxConcurrentJobs),
    [downloadRecording, directory, maxConcurrentJobs],
  );
  const deleteChosen = () => {
    scheduleDelete(selection.chosen.map(deleteTarget));
    selection.clear();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (isEditableTarget(event.target)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selection.selectAll();
    } else if (event.key === "Escape" && selection.chosen.length > 0) {
      event.preventDefault();
      selection.clear();
    }
  };

  return (
    <section className={styles.list} aria-label={title} onKeyDown={onKeyDown}>
      <div className={cn(styles.rows, selection.chosen.length > 0 && styles.rowsSelecting)}>
        {groups.length === 0 && (loading ? <ListSkeleton /> : <p className={styles.empty}>{emptyText}</p>)}
        {groups.map((group) => (
          <div key={group.label} className={styles.group}>
            <div className={styles.dayLabel}>{group.label}</div>
            {group.items.map((recording) => {
              const index = order.get(recording.session) ?? INTRO_ROWS;
              return (
                <RecordingRow
                  key={recording.session}
                  recording={recording}
                  clips={clipCounts.get(recording.session) ?? 0}
                  active={recording.session === selected}
                  checked={selection.isChosen(recording.session)}
                  introIndex={intro && index < INTRO_ROWS ? index : null}
                  canDownload={Boolean(directory)}
                  onSelect={onSelect}
                  onToggle={selection.toggle}
                  onDelete={deleteOne}
                  onDownload={downloadOne}
                />
              );
            })}
          </div>
        ))}
      </div>

      {selection.chosen.length > 0 && (
        <BatchBar chosen={selection.chosen} onDelete={deleteChosen} onDone={selection.clear} />
      )}
    </section>
  );
}

function ListSkeleton() {
  return (
    <div className={styles.skeleton} role="status" aria-label="Загружаю записи">
      {SKELETON_ROWS.map((index) => (
        <span key={index} className={styles.skeletonRow} style={{ animationDelay: `${index * SKELETON_STEP_MS}ms` }} aria-hidden>
          <span className={styles.skeletonPoster} />
          <span className={styles.skeletonText}>
            <span />
            <span />
          </span>
        </span>
      ))}
    </div>
  );
}

interface RowMeta {
  /** «в эфире · 18:04–21:16 · 4,2 ГБ» */
  status: string;
  channel: string | null;
  clips: number;
}

/** Две серые строки: «18:04–сейчас · 4,2 ГБ» и «канал · ✂ 3». */
function rowMeta(recording: VpsRecordingMeta, clips: number): RowMeta {
  const live = isLive(recording);
  const channel = recording.title?.trim() && recording.channel ? channelLabel(recording.channel) : null;
  const end = live ? "сейчас" : timeOf(recording.ended_at ?? recording.started_at + recording.duration);
  const when = isWaiting(recording)
    ? recording.status === "reconnecting" ? "переподключаемся" : "ждём эфир"
    : `${timeOf(recording.started_at)}–${end}`;
  const gone = !recording.available && !live;
  const size = recording.available && recording.video_size > 0 ? fmtBytes(recording.video_size) : null;
  const status = [
    live && !isWaiting(recording) && recording.status === "reconnecting" ? "нет связи" : null,
    when,
    size,
    gone ? "видео удалено" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { status, channel, clips };
}

function metaLabel(meta: RowMeta): string {
  return [meta.status, meta.channel, meta.clips > 0 ? `клипов: ${meta.clips}` : null].filter(Boolean).join(", ");
}

function rowHint(recording: VpsRecordingMeta, name: string): string {
  const gaps = recording.gaps?.length ?? 0;
  return [
    name,
    !recording.available && !isLive(recording) ? "Видео удалено, чтобы освободить место на сервере. Метки и клипы остались." : null,
    recording.available_start > 0 ? "Начало записи удалено ротацией, остальное можно смотреть и резать." : null,
    gaps > 0 ? `Разрывов связи: ${gaps}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

interface RecordingRowProps {
  recording: VpsRecordingMeta;
  clips: number;
  active: boolean;
  checked: boolean;
  introIndex: number | null;
  canDownload: boolean;
  onSelect: (session: string) => void;
  onToggle: (session: string, range: boolean) => void;
  onDelete: (recording: VpsRecordingMeta) => void;
  onDownload: (recording: VpsRecordingMeta) => void;
}

const RecordingRow = memo(function RecordingRow(props: RecordingRowProps) {
  const { recording, active, checked, introIndex, onSelect } = props;
  const live = isLive(recording);
  const name = recordingTitle(recording);
  const meta = rowMeta(recording, props.clips);

  return (
    <div
      className={cn(styles.row, active && styles.rowActive, checked && styles.rowChecked, introIndex != null && styles.rowIntro)}
      style={introIndex != null ? { animationDelay: `${introIndex * 24}ms` } : undefined}
    >
      <button
        type="button"
        className={styles.rowOpen}
        onClick={() => onSelect(recording.session)}
        aria-current={active || undefined}
        aria-label={`${name}, ${metaLabel(meta)}`}
        title={rowHint(recording, name)}
      >
        <RowPoster recording={recording} />
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>{name}</span>
          <span className={styles.rowMeta}>
            {live && !isWaiting(recording) && (
              <span className={cn(styles.liveDot, recording.status === "reconnecting" && styles.liveDotWarn)} aria-hidden />
            )}
            {meta.status}
          </span>
          {(meta.channel || meta.clips > 0) && (
            <span className={styles.rowSub}>
              {meta.channel && <span className={styles.rowChannel}>{meta.channel}</span>}
              {meta.clips > 0 && <span className={styles.rowClips}>✂ {meta.clips}</span>}
            </span>
          )}
        </span>
      </button>
      {!live && <RowActions {...props} name={name} />}
    </div>
  );
});

function RowPoster({ recording }: { recording: VpsRecordingMeta }) {
  const waiting = isWaiting(recording);
  const gone = !recording.available && !isLive(recording);
  const cut = recording.available_start > 0 && recording.duration > 0 ? Math.min(1, recording.available_start / recording.duration) : 0;
  return (
    <span className={cn(styles.rowPoster, gone && styles.rowPosterGone)}>
      {waiting ? (
        <RedesignIcon name="time" className={styles.rowPosterIcon} />
      ) : (
        <PosterImage kind="recording" id={recording.session} at={recording.available_start + 5} alt="" />
      )}
      {!waiting && recording.duration > 0 && <span className={styles.rowDuration}>{fmtDuration(recording.duration)}</span>}
      {cut > 0 && (
        <span className={styles.rowCut} aria-hidden>
          <i style={{ transform: `scaleX(${cut})` }} />
        </span>
      )}
    </span>
  );
}

function RowActions({
  recording,
  checked,
  canDownload,
  name,
  onToggle,
  onDelete,
  onDownload,
}: RecordingRowProps & { name: string }) {
  const downloading = useVpsRecorderStore((s) => Boolean(s.busy[`dl_rec_${recording.session}`]));
  return (
    <>
      <button
        type="button"
        className={styles.rowCheck}
        aria-pressed={checked}
        aria-label={`Выбрать запись «${name}»`}
        title="Выбрать · Shift — диапазон, Ctrl+A — все, Esc — снять"
        onClick={(event) => onToggle(recording.session, event.shiftKey)}
      />
      <span className={styles.rowActions}>
        <button
          type="button"
          className={styles.rowAction}
          disabled={!recording.available || !canDownload || downloading}
          aria-label={`Скачать запись «${name}»`}
          title={
            !recording.available
              ? "Видео уже удалено с сервера"
              : canDownload
                ? `Скачать всю запись · ${fmtBytes(recording.video_size)}`
                : "Сначала укажите папку в настройках"
          }
          onClick={() => onDownload(recording)}
        >
          <RedesignIcon name={downloading ? "loading" : "download"} className={cn("size-3.5", downloading && styles.spinning)} />
        </button>
        <button
          type="button"
          className={cn(styles.rowAction, styles.rowActionDanger)}
          aria-label={`Удалить запись «${name}» с сервера`}
          title="Удалить запись с сервера (5 секунд можно отменить)"
          onClick={() => onDelete(recording)}
        >
          <RedesignIcon name="trash" className="size-3.5" />
        </button>
      </span>
    </>
  );
}
