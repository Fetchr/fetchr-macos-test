import { useId, useState } from "react";

import type { VpsRecordingMeta } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useVpsRecorderStore } from "@/stores/vpsRecorder";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { fmtDuration, parseTimecode } from "./format";
import detail from "./RecordingDetail.module.css";

interface ClipEditorProps {
  recording: VpsRecordingMeta;
  position: number;
  rangeStart: string;
  rangeEnd: string;
  onRangeStart: (value: string) => void;
  onRangeEnd: (value: string) => void;
  /** Current player position, for the I / O buttons. */
  currentTime: () => number;
}

/**
 * Cutting happens on the server: only the finished clip is ever transferred,
 * so a two-minute moment out of a six-hour stream costs a two-minute download
 * instead of pulling the whole recording down first.
 *
 * Until a range exists this is a single hint line: a full form of disabled
 * fields under every recording was the loudest thing on the screen.
 */
export function ClipEditor(props: ClipEditorProps) {
  const { rangeStart, rangeEnd } = props;
  const [manual, setManual] = useState(false);
  const open = manual || Boolean(rangeStart.trim() || rangeEnd.trim());

  if (!open) {
    return (
      <section className={detail.clipHint} aria-label="Новый клип">
        <RedesignIcon name="media" />
        <span>
          Выделите отрезок: протяните по таймлайну с <kbd className={detail.kbd}>Shift</kbd> или нажмите{" "}
          <kbd className={detail.kbd}>I</kbd> и <kbd className={detail.kbd}>O</kbd>
        </span>
        <button type="button" className={detail.clipHintAction} onClick={() => setManual(true)}>
          Ввести время
        </button>
      </section>
    );
  }

  return (
    <ClipPanel
      {...props}
      onReset={() => {
        setManual(false);
        props.onRangeStart("");
        props.onRangeEnd("");
      }}
    />
  );
}

function clipProblem(recording: VpsRecordingMeta, rangeStart: string, rangeEnd: string, position: number) {
  const startSec = parseTimecode(rangeStart);
  const endSec = parseTimecode(rangeEnd);
  const valid = Boolean(
    recording.available &&
      startSec != null &&
      endSec != null &&
      startSec >= recording.available_start &&
      endSec - startSec >= 1 &&
      endSec <= position + 1,
  );
  // Why «Создать клип» is off, in words: a bare disabled button left people guessing.
  const reason = valid
    ? null
    : !recording.available
      ? "Видео записи удалено с сервера — клип из неё не собрать."
      : (rangeStart.trim() && startSec == null) || (rangeEnd.trim() && endSec == null)
        ? "Время пишется как 1:23 или 1:02:03."
        : startSec == null || endSec == null
          ? null
          : startSec < recording.available_start
            ? `Начало раньше ${fmtDuration(recording.available_start)} уже удалено ротацией.`
            : endSec - startSec < 1
              ? "Конец должен быть позже начала."
              : "Конец позже того, что уже записано.";
  return { startSec, endSec, valid, reason };
}

function ClipPanel({
  recording,
  position,
  rangeStart,
  rangeEnd,
  onRangeStart,
  onRangeEnd,
  currentTime,
  onReset,
}: ClipEditorProps & { onReset: () => void }) {
  const busy = useVpsRecorderStore((s) => s.busy);
  const saveClip = useVpsRecorderStore((s) => s.saveClip);
  const [label, setLabel] = useState("");
  const reasonId = useId();

  const { startSec, endSec, valid, reason } = clipProblem(recording, rangeStart, rangeEnd, position);
  const crossesGap = (recording.gaps ?? []).some(
    (gap) => startSec != null && endSec != null && gap.start < endSec && gap.end > startSec,
  );
  const length = valid ? (endSec ?? 0) - (startSec ?? 0) : null;

  const handleSave = async () => {
    if (!valid || startSec == null || endSec == null) return;
    try {
      // Frame-accurate cutting is only forced when the range crosses a
      // reconnect; otherwise a stream copy is both faster and lossless.
      await saveClip(recording.session, startSec, endSec, label.trim(), "", [], crossesGap);
      setLabel("");
    } catch {
      // The store already surfaced the actionable error.
    }
  };

  return (
    <section className={cn(detail.clipBar, detail.clipBarOpen)} aria-label="Новый клип">
      <div className={detail.clipRow}>
        <TimecodeField
          label="Начало"
          hotkey="I"
          value={rangeStart}
          onChange={onRangeStart}
          onTake={() => onRangeStart(fmtDuration(currentTime()))}
        />
        <span className={detail.clipArrow} aria-hidden="true">
          →
        </span>
        <TimecodeField
          label="Конец"
          hotkey="O"
          value={rangeEnd}
          onChange={onRangeEnd}
          onTake={() => onRangeEnd(fmtDuration(currentTime()))}
        />
        <span className={cn(detail.clipLength, length == null && detail.clipLengthEmpty)}>
          {length != null ? fmtDuration(length) : "—"}
        </span>
        <input
          className={cn(detail.field, detail.clipName)}
          placeholder="Название, необязательно"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy.clip) void handleSave();
          }}
          aria-label="Название клипа"
        />
        <button type="button" className={detail.clipReset} onClick={onReset} title="Снять выделение">
          Сбросить
        </button>
        <button
          type="button"
          className={detail.cut}
          disabled={!valid || busy.clip}
          onClick={() => void handleSave()}
          aria-busy={busy.clip}
          aria-describedby={reason ? reasonId : undefined}
        >
          <RedesignIcon name={busy.clip ? "loading" : "save"} className={busy.clip ? detail.spinning : undefined} />
          Создать клип
        </button>
      </div>

      {reason && (
        <p id={reasonId} className={detail.clipNote} role="status">
          <RedesignIcon name="info" />
          {reason}
        </p>
      )}

      {crossesGap && (
        <p className={detail.clipNote}>
          <RedesignIcon name="info" />
          Клип попадает на разрыв связи: соберётся дольше, зато склейка не рассыплется.
        </p>
      )}
    </section>
  );
}

function TimecodeField({
  label,
  hotkey,
  value,
  onChange,
  onTake,
}: {
  label: string;
  hotkey: string;
  value: string;
  onChange: (value: string) => void;
  onTake: () => void;
}) {
  return (
    <span className={detail.timecode}>
      <input
        className={detail.timecodeInput}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="0:00"
        aria-label={label}
        spellCheck={false}
      />
      <button
        type="button"
        className={detail.timecodeTake}
        onClick={onTake}
        title={`${label}: взять текущую позицию плеера (клавиша ${hotkey})`}
        aria-label={`${label}: текущая позиция`}
      >
        {hotkey}
      </button>
    </span>
  );
}
