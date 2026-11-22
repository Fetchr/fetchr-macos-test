import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./DownloadOverlay.module.css";
import { formatClock, parseClock } from "./rowOverrides";

export interface ExtraRangeItem {
  id?: string;
  start: string;
  end: string;
}

interface RangePickerProps {
  /** Длина записи в секундах; без неё только поля времени. */
  length: number | null;
  start: string;
  end: string;
  initialStart?: string;
  approximate?: boolean;
  onChange: (next: { start: string; end: string }) => void;
  extraRanges?: ExtraRangeItem[];
  onExtraRangesChange?: (next: ExtraRangeItem[]) => void;
}

const MIN_CLIP = 1;
const START_PLACEHOLDER = "с начала · 1:23:45";
const END_PLACEHOLDER = "до конца · 1:23:45";
const FORMAT_HINT = "Неверное время. Формат: 1:23:45, 23:45, 45 или 1h23m45s.";
const extraKeyMap = new WeakMap<object, string>();
let extraKeySeq = 0;

function getExtraRangeKey(item: ExtraRangeItem): string {
  if (item.id) return item.id;
  let key = extraKeyMap.get(item);
  if (!key) {
    extraKeySeq += 1;
    key = `extra-${extraKeySeq}`;
    extraKeyMap.set(item, key);
  }
  return key;
}

/** Фрагмент записи: две ручки по длине и поля времени. Пустые поля значат «вся запись». */
export function RangePicker({
  length,
  start,
  end,
  initialStart,
  approximate,
  onChange,
  extraRanges,
  onExtraRangesChange,
}: RangePickerProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set());
  const setFieldValidity = (field: string, valid: boolean) =>
    setInvalidFields((current) => {
      if (valid !== current.has(field)) return current;
      return valid ? new Set([...current].filter((item) => item !== field)) : new Set(current).add(field);
    });
  const from = Math.min(parseClock(start) ?? 0, length ?? Infinity);
  const rawTo = length ? Math.min(parseClock(end) ?? length, length) : (parseClock(end) ?? 0);
  const to = length ? Math.max(from, rawTo) : rawTo;
  const hasExtras = Boolean(extraRanges && extraRanges.some((r) => r.start.trim() || r.end.trim()));
  const hasAnyRange = Boolean(start.trim() || end.trim() || hasExtras);
  const whole = length !== null && from === 0 && to >= length && !hasExtras;
  const isFromUrlTimecode = Boolean(initialStart && start === initialStart && !end);

  const boundsRef = useRef({ from, to });
  boundsRef.current = { from, to };

  const commit = (nextFrom: number, nextTo: number) => {
    if (!length) return;
    const a = Math.max(0, Math.min(nextFrom, length - MIN_CLIP));
    const b = Math.min(length, Math.max(nextTo, a + MIN_CLIP));
    onChange({ start: a > 0 ? formatClock(a) : "", end: b < length ? formatClock(b) : "" });
  };

  const move = (handle: 0 | 1, seconds: number) => {
    const cur = boundsRef.current;
    if (handle === 0) commit(Math.min(seconds, cur.to - MIN_CLIP), cur.to);
    else commit(cur.from, Math.max(seconds, cur.from + MIN_CLIP));
  };

  const startDrag = (target: HTMLElement, pointerId: number, handle: 0 | 1) => {
    target.setPointerCapture(pointerId);
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || !length) return;
      move(handle, Math.round(((moveEvent.clientX - rect.left) / rect.width) * length));
    };
    const stop = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", stop);
      target.removeEventListener("pointercancel", stop);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", stop);
    target.addEventListener("pointercancel", stop);
  };

  const onPointerDown = (handle: 0 | 1) => (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    startDrag(event.currentTarget, event.pointerId, handle);
  };

  const onTrackPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!length || !trackRef.current) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const rect = trackRef.current.getBoundingClientRect();
    if (!rect.width) return;
    const seconds = Math.max(0, Math.min(length, Math.round(((event.clientX - rect.left) / rect.width) * length)));
    const distFrom = Math.abs(seconds - from);
    const distTo = Math.abs(seconds - to);
    const handle: 0 | 1 = distFrom < distTo ? 0 : distTo < distFrom ? 1 : seconds < from ? 0 : 1;
    move(handle, seconds);
    startDrag( event.currentTarget, event.pointerId, handle);
  };

  const onKeyDown = (handle: 0 | 1) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.ctrlKey || event.metaKey ? 60 : event.shiftKey ? 10 : 1;
    const current = handle === 0 ? from : to;
    if (event.key === "ArrowLeft") move(handle, current - step);
    else if (event.key === "ArrowRight") move(handle, current + step);
    else return;
    event.preventDefault();
  };

  const commitStart = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) {
      onChange({ start: "", end });
      return "";
    }
    const parsed = parseClock(trimmed);
    if (parsed === null) return start;
    const maxEnd = end ? (parseClock(end) ?? (length ?? Infinity)) : (length ?? Infinity);
    const clamped = Math.max(0, Math.min(parsed, Math.max(0, maxEnd - MIN_CLIP)));
    const formatted = clamped > 0 ? formatClock(clamped) : "";
    onChange({ start: formatted, end });
    return formatted;
  };

  const commitEnd = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) {
      onChange({ start, end: "" });
      return "";
    }
    const parsed = parseClock(trimmed);
    if (parsed === null) return end;
    const minStart = parseClock(start) ?? 0;
    const maxLen = length ?? Infinity;
    const clamped = Math.min(maxLen, Math.max(parsed, minStart + MIN_CLIP));
    const formatted = length && clamped >= length ? "" : formatClock(clamped);
    onChange({ start, end: formatted });
    return formatted;
  };

  const updateExtra = (index: number, field: "start" | "end", raw: string): string => {
    if (!extraRanges || !onExtraRangesChange) return "";
    const current = extraRanges[index] ?? { start: "", end: "" };
    const trimmed = raw.trim();
    if (!trimmed) {
      onExtraRangesChange(extraRanges.map((item, i) => (i === index ? { ...current, [field]: "" } : item)));
      return "";
    }
    const parsed = parseClock(trimmed);
    if (parsed === null) return current[field];
    if (field === "start") {
      const maxEnd = current.end ? (parseClock(current.end) ?? (length ?? Infinity)) : (length ?? Infinity);
      const clamped = Math.max(0, Math.min(parsed, Math.max(0, maxEnd - MIN_CLIP)));
      const formatted = clamped > 0 ? formatClock(clamped) : "";
      onExtraRangesChange(extraRanges.map((item, i) => (i === index ? { ...current, start: formatted } : item)));
      return formatted;
    }
    const minStart = parseClock(current.start) ?? 0;
    const maxLen = length ?? Infinity;
    const clamped = Math.min(maxLen, Math.max(parsed, minStart + MIN_CLIP));
    const formatted = length && clamped >= length ? "" : formatClock(clamped);
    onExtraRangesChange(extraRanges.map((item, i) => (i === index ? { ...current, end: formatted } : item)));
    return formatted;
  };

  const left = length ? Math.max(0, Math.min(100, (from / length) * 100)) : 0;
  const right = length ? Math.max(left, Math.min(100, (to / length) * 100)) : 100;

  const resetAllRanges = () => {
    onChange({ start: "", end: "" });
    if (extraRanges?.length) onExtraRangesChange?.([]);
  };

  return (
    <div className={styles.section}>
      <div className={styles.rangeInfo}>
        <span className={styles.sectionLabel}>Фрагмент</span>
        <span className={styles.rangeInfoRight}>
          <span>
            {length ? `${approximate ? "≈ " : ""}${formatClock(Math.max(0, to - from))}` : ""}
            {whole ? " · вся запись" : ""}
          </span>
          {hasAnyRange && (
            <button type="button" className={styles.rangeResetBtn} onClick={resetAllRanges}>
              Сбросить (вся запись)
            </button>
          )}
        </span>
      </div>
      {isFromUrlTimecode && (
        <div className={styles.urlTimecodeNotice}>
          <span>
            <RedesignIcon name="time" className="size-3.5" />
            Таймкод из ссылки: с <b>{start}</b>
          </span>
          <button type="button" className={styles.urlTimecodeReset} onClick={() => onChange({ start: "", end: "" })}>
            Скачать целиком
          </button>
        </div>
      )}
      {length ? (
        <div className={styles.range} ref={trackRef} onPointerDown={onTrackPointerDown}>
          {extraRanges?.map((item) => {
            if (!item.start.trim() && !item.end.trim()) return null;
            const eFrom = Math.max(0, Math.min(parseClock(item.start) ?? 0, length));
            const eTo = Math.max(eFrom, Math.min(parseClock(item.end) ?? length, length));
            const eLeft = Math.max(0, Math.min(100, (eFrom / length) * 100));
            const eRight = Math.max(eLeft, Math.min(100, (eTo / length) * 100));
            return (
              <div
                key={getExtraRangeKey(item)}
                className={styles.rangeSelExtra}
                style={{ left: `${eLeft}%`, width: `${Math.max(0, eRight - eLeft)}%` }}
              />
            );
          })}
          <div className={styles.rangeSel} style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }} />
          {([0, 1] as const).map((handle) => (
            <button
              key={handle}
              type="button"
              className={styles.rangeHandle}
              style={{ left: `${handle === 0 ? left : right}%` }}
              aria-label={handle === 0 ? "Начало фрагмента" : "Конец фрагмента"}
              aria-valuetext={formatClock(handle === 0 ? from : to)}
              role="slider"
              aria-valuemin={0}
              aria-valuemax={length}
              aria-valuenow={handle === 0 ? from : to}
              onPointerDown={onPointerDown(handle)}
              onKeyDown={onKeyDown(handle)}
            />
          ))}
        </div>
      ) : null}
      <div className={styles.rangeRow}>
        <ClockInput
          label="Начало"
          placeholder={START_PLACEHOLDER}
          value={start}
          onCommit={commitStart}
          onValidity={(valid) => setFieldValidity("start", valid)}
        />
        <span className={styles.rangeDash} aria-hidden>
          –
        </span>
        <ClockInput
          label="Конец"
          placeholder={END_PLACEHOLDER}
          value={end}
          onCommit={commitEnd}
          onValidity={(valid) => setFieldValidity("end", valid)}
        />
      </div>
      {extraRanges?.map((item, idx) => (
        <div key={getExtraRangeKey(item)} className={styles.rangeRow}>
          <ClockInput
            label={`Начало фрагмента ${idx + 2}`}
            placeholder={START_PLACEHOLDER}
            value={item.start}
            onCommit={(val) => updateExtra(idx, "start", val)}
            onValidity={(valid) => setFieldValidity(`${getExtraRangeKey(item)}:start`, valid)}
          />
          <span className={styles.rangeDash} aria-hidden>
            –
          </span>
          <ClockInput
            label={`Конец фрагмента ${idx + 2}`}
            placeholder={END_PLACEHOLDER}
            value={item.end}
            onCommit={(val) => updateExtra(idx, "end", val)}
            onValidity={(valid) => setFieldValidity(`${getExtraRangeKey(item)}:end`, valid)}
          />
          <button
            type="button"
            className={styles.rangeRemove}
            aria-label={`Удалить фрагмент ${idx + 2}`}
            title="Удалить фрагмент"
            onClick={() => onExtraRangesChange?.(extraRanges.filter((_, i) => i !== idx))}
          >
            <RedesignIcon name="close" className="size-3.5" />
          </button>
        </div>
      ))}
      {invalidFields.size > 0 && (
        <p className={styles.rangeError} role="alert">
          {FORMAT_HINT}
        </p>
      )}
      {onExtraRangesChange && (
        <button
          type="button"
          className={styles.rangeAdd}
          onClick={() => onExtraRangesChange([...(extraRanges ?? []), { id: crypto.randomUUID(), start: "", end: "" }])}
        >
          + ещё фрагмент
        </button>
      )}
    </div>
  );
}

/**
 * Поле времени: правится свободно, применяется по Enter или потере фокуса.
 * Нераспознанное время не откатывается молча: поле подсвечивается, текст остаётся для правки.
 */
function ClockInput({
  label,
  placeholder,
  value,
  onCommit,
  onValidity,
}: {
  label: string;
  placeholder: string;
  value: string;
  onCommit: (value: string) => string;
  onValidity: (valid: boolean) => void;
}) {
  const [text, setText] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const textRef = useRef(value);
  const validityRef = useRef(onValidity);
  validityRef.current = onValidity;
  useEffect(() => {
    textRef.current = value;
    setText(value);
    setInvalid(false);
  }, [value]);
  useEffect(() => {
    validityRef.current(!invalid);
  }, [invalid]);
  useEffect(() => () => validityRef.current(true), []);
  const commit = () => {
    const raw = textRef.current.trim();
    if (raw && parseClock(raw) === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const next = onCommit(textRef.current);
    textRef.current = next;
    setText(next);
  };
  return (
    <input
      className={`${styles.textInput} ${styles.mono}`}
      value={text}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={invalid || undefined}
      title={invalid ? FORMAT_HINT : "Формат: 1:23:45, 23:45 или 45; пусто — граница записи"}
      inputMode="numeric"
      onChange={(event) => {
        textRef.current = event.target.value;
        setText(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          if (!event.ctrlKey && !event.metaKey) {
            event.preventDefault();
          }
          commit();
        }
      }}
    />
  );
}
