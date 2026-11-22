import { useTranslation } from "react-i18next";
import { useRef, useState, useEffect, useMemo } from "react";
import { formatHms, parseTimeInput } from "@/lib/timecode";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./AddTaskModal.module.css";

export interface TimecodeRange {
  id: string;
  start: string;
  end: string;
}

export interface TimecodeRangeListProps {
  start: string;
  end: string;
  ranges: TimecodeRange[];
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onAddRange: () => void;
  onUpdateRange: (id: string, patch: Partial<Pick<TimecodeRange, "start" | "end">>) => void;
  onRemoveRange: (id: string) => void;
}

export function TimecodeRangeList({
  start,
  end,
  ranges,
  onStartChange,
  onEndChange,
  onAddRange,
  onUpdateRange,
  onRemoveRange,
}: TimecodeRangeListProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.ranges}>
      <div className={styles.rangeEditor}>
        <TimecodePicker value={start} onChange={onStartChange} />
        <span className={styles.rangeDash} aria-hidden>—</span>
        <TimecodePicker value={end} onChange={onEndChange} />
        <button className={styles.button} type="button" onClick={onAddRange}>
          <RedesignIcon name="add" className="size-4" />
          {t("add.add_range", "Добавить диапазон")}
        </button>
      </div>

      {ranges.length > 0 && (
        <div className={styles.rangeList}>
          {ranges.map((range, index) => (
            <div className={styles.rangeItem} key={range.id}>
              <span className={styles.rangeIndex}>#{index + 1}</span>
              <TimecodePicker
                value={range.start}
                onChange={(value) => onUpdateRange(range.id, { start: value })}
              />
              <span className={styles.sectionMeta}>{t("add.to", "до")}</span>
              <TimecodePicker
                value={range.end}
                onChange={(value) => onUpdateRange(range.id, { end: value })}
              />
              <button className={styles.iconButton} type="button" aria-label={t("common.remove", "Удалить")} onClick={() => onRemoveRange(range.id)}>
                <RedesignIcon name="trash" className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface TimecodePickerProps {
  value: string;
  onChange: (value: string) => void;
}

function TimecodePicker({ value, onChange }: TimecodePickerProps) {
  const hhRef = useRef<HTMLInputElement>(null);
  const mmRef = useRef<HTMLInputElement>(null);
  const ssRef = useRef<HTMLInputElement>(null);

  const lastSentValueRef = useRef("");
  const parsed = useMemo(() => parseTimecode(value), [value]);

  const [localHh, setLocalHh] = useState(parsed.hh);
  const [localMm, setLocalMm] = useState(parsed.mm);
  const [localSs, setLocalSs] = useState(parsed.ss);

  useEffect(() => {
    // If the parent value matches what we last sent, do not sync (it is just an echo of our typing)
    if (value !== lastSentValueRef.current) {
      setLocalHh(parsed.hh);
      setLocalMm(parsed.mm);
      setLocalSs(parsed.ss);
      lastSentValueRef.current = value;
    }
  }, [value, parsed]);

  const updateParent = (h: string, m: string, s: string) => {
    const formatted = formatTimecodeStr(h, m, s);
    lastSentValueRef.current = formatted;
    onChange(formatted);
  };

  const handleHhChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value.replace(/\D/g, "");
    if (val.length > 2) {
      val = val.slice(-2);
    }
    setLocalHh(val);
    updateParent(val, localMm, localSs);
    if (val.length === 2) {
      requestAnimationFrame(() => {
        mmRef.current?.focus();
        mmRef.current?.select();
      });
    }
  };

  const handleMmChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value.replace(/\D/g, "");
    if (val.length > 2) {
      val = val.slice(-2);
    }
    if (val !== "" && Number(val) > 59) {
      val = "59";
    }
    setLocalMm(val);
    updateParent(localHh, val, localSs);
    if (val.length === 2) {
      requestAnimationFrame(() => {
        ssRef.current?.focus();
        ssRef.current?.select();
      });
    }
  };

  const handleSsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value.replace(/\D/g, "");
    if (val.length > 2) {
      val = val.slice(-2);
    }
    if (val !== "" && Number(val) > 59) {
      val = "59";
    }
    setLocalSs(val);
    updateParent(localHh, localMm, val);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text").trim();
    if (!/[:hms]/i.test(text) && text.length <= 2) return;
    const seconds = parseTimeInput(text);
    if (seconds === null) return;
    e.preventDefault();
    const formatted = formatHms(seconds);
    const [h, m, s] = formatted.split(":");
    setLocalHh(h);
    setLocalMm(m);
    setLocalSs(s);
    lastSentValueRef.current = formatted;
    onChange(formatted);
  };

  const handleBlur = () => {
    if (!localHh && !localMm && !localSs) return;
    const clamp59 = (v: string) => (v ? String(Math.min(59, Number(v))).padStart(2, "0") : "00");
    const paddedH = (localHh || "00").padStart(2, "0");
    const paddedM = clamp59(localMm);
    const paddedS = clamp59(localSs);
    setLocalHh(paddedH);
    setLocalMm(paddedM);
    setLocalSs(paddedS);
    updateParent(paddedH, paddedM, paddedS);
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.select();
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    current: "hh" | "mm" | "ss",
    val: string
  ) => {
    if (e.key === "Backspace" && val === "") {
      if (current === "mm") {
        hhRef.current?.focus();
        hhRef.current?.select();
      } else if (current === "ss") {
        mmRef.current?.focus();
        mmRef.current?.select();
      }
    }
  };

  return (
    <div className={styles.timecodePicker}>
      <input
        ref={hhRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        placeholder="00"
        value={localHh}
        onChange={handleHhChange}
        onPaste={handlePaste}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={(e) => handleKeyDown(e, "hh", localHh)}
        className={styles.timecodeSubInput}
      />
      <span className={styles.timecodeSep}>:</span>
      <input
        ref={mmRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        placeholder="00"
        value={localMm}
        onChange={handleMmChange}
        onPaste={handlePaste}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={(e) => handleKeyDown(e, "mm", localMm)}
        className={styles.timecodeSubInput}
      />
      <span className={styles.timecodeSep}>:</span>
      <input
        ref={ssRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        placeholder="00"
        value={localSs}
        onChange={handleSsChange}
        onPaste={handlePaste}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={(e) => handleKeyDown(e, "ss", localSs)}
        className={styles.timecodeSubInput}
      />
    </div>
  );
}

function parseTimecode(value: string) {
  if (!value) {
    return { hh: "", mm: "", ss: "" };
  }
  const parts = value.split(":");
  return {
    hh: parts[0] || "",
    mm: parts[1] || "",
    ss: parts[2] || "",
  };
}

function formatTimecodeStr(hh: string, mm: string, ss: string): string {
  if (!hh && !mm && !ss) return "";
  const h = hh.padStart(2, "0");
  const m = mm.padStart(2, "0");
  const s = ss.padStart(2, "0");
  return `${h}:${m}:${s}`;
}
