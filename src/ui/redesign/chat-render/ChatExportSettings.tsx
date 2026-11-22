import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SystemFont } from "@/types/job";

import styles from "./ChatRenderPage.module.css";
import { Select } from "@/components/ui/select";

interface ChatFontSettingsProps {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  usernameFontWeight: number;
  outlineEnabled: boolean;
  outlineThickness: number;
  backgroundEnabled: boolean;
  backgroundOpacity: number;
  backgroundBlurEnabled: boolean;
  systemFonts: SystemFont[];
  onFontFamilyChange: (value: string) => void;
  onFontSizeChange: (value: number) => void;
  onFontWeightChange: (value: number) => void;
  onUsernameFontWeightChange: (value: number) => void;
  onOutlineEnabledChange: (value: boolean) => void;
  onOutlineThicknessChange: (value: number) => void;
  onBackgroundEnabledChange: (value: boolean) => void;
  onBackgroundOpacityChange: (value: number) => void;
  onBackgroundBlurEnabledChange: (value: boolean) => void;
}

export function ChatFontSettings({
  fontFamily,
  fontSize,
  fontWeight,
  usernameFontWeight,
  outlineEnabled,
  outlineThickness,
  backgroundEnabled,
  backgroundOpacity,
  backgroundBlurEnabled,
  systemFonts,
  onFontFamilyChange,
  onFontSizeChange,
  onFontWeightChange,
  onUsernameFontWeightChange,
  onOutlineEnabledChange,
  onOutlineThicknessChange,
  onBackgroundEnabledChange,
  onBackgroundOpacityChange,
  onBackgroundBlurEnabledChange,
}: ChatFontSettingsProps) {
  const selectedFont = systemFonts.find((font) => font.family === fontFamily);
  const fontOptions = buildFontOptions(systemFonts, fontFamily);
  const weightOptions = buildWeightOptions(selectedFont?.weights, [fontWeight, usernameFontWeight]);

  return (
    <div className={styles.fontSettingsContainer}>
      <SelectField
        className={styles.compactField}
        label="Шрифт"
        value={fontFamily}
        onChange={onFontFamilyChange}
        options={fontOptions}
      />
      <NumberField
        className={styles.compactField}
        label="Размер"
        value={fontSize}
        min={10}
        max={72}
        onChange={onFontSizeChange}
      />
      <SelectField
        className={styles.compactField}
        label="Вес текста"
        value={String(fontWeight)}
        onChange={(value) => onFontWeightChange(Number(value))}
        options={weightOptions}
      />
      <SelectField
        className={styles.compactField}
        label="Вес ника"
        value={String(usernameFontWeight)}
        onChange={(value) => onUsernameFontWeightChange(Number(value))}
        options={weightOptions}
      />
      <OutlinePill
        enabled={outlineEnabled}
        thickness={outlineThickness}
        onEnabledChange={onOutlineEnabledChange}
        onThicknessChange={onOutlineThicknessChange}
      />
      <BackgroundPill
        enabled={backgroundEnabled}
        opacity={backgroundOpacity}
        blurEnabled={backgroundBlurEnabled}
        onEnabledChange={onBackgroundEnabledChange}
        onOpacityChange={onBackgroundOpacityChange}
        onBlurEnabledChange={onBackgroundBlurEnabledChange}
      />
    </div>
  );
}

/** Toggle + thickness stepper packed into one pill. */
function OutlinePill({
  enabled,
  thickness,
  onEnabledChange,
  onThicknessChange,
}: {
  enabled: boolean;
  thickness: number;
  onEnabledChange: (value: boolean) => void;
  onThicknessChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={`${styles.pill} ${enabled ? styles.pillActive : ""}`}>
      <button type="button" className={styles.pillLabel} onClick={() => onEnabledChange(!enabled)}>
        Обводка
      </button>
      <span className={styles.pillDivider} />
      <button
        type="button"
        className={styles.pillStep}
        disabled={!enabled || thickness <= 0}
        onClick={() => onThicknessChange(thickness - 1)}
        aria-label={t("chat_render.umenshit_tolschinu_obvodki", "Уменьшить толщину обводки")}
      >
        −
      </button>
      <span className={styles.pillValue}>{enabled ? thickness : "—"}</span>
      <button
        type="button"
        className={styles.pillStep}
        disabled={!enabled || thickness >= 12}
        onClick={() => onThicknessChange(thickness + 1)}
        aria-label={t("chat_render.uvelichit_tolschinu_obvodki", "Увеличить толщину обводки")}
      >
        +
      </button>
    </div>
  );
}

/** Toggle + popover with opacity and blur. */
function BackgroundPill({
  enabled,
  opacity,
  blurEnabled,
  onEnabledChange,
  onOpacityChange,
  onBlurEnabledChange,
}: {
  enabled: boolean;
  opacity: number;
  blurEnabled: boolean;
  onEnabledChange: (value: boolean) => void;
  onOpacityChange: (value: number) => void;
  onBlurEnabledChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`${styles.pill} ${enabled ? styles.pillActive : ""}`}>
      <button type="button" className={styles.pillLabel} onClick={() => onEnabledChange(!enabled)}>
        Фон
      </button>
      <span className={styles.pillDivider} />
      <button
        type="button"
        className={`${styles.pillArrow} ${open ? styles.pillArrowOpen : ""}`}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={t("chat_render.dopolnitelnye_nastroyki_fona", "Дополнительные настройки фона")}
      >
        ▾
      </button>
      {open && (
        <div className={styles.pillPopover}>
          <div className={styles.pillPopoverRow}>
            <span className={styles.label}>{t("chat_render.prozrachnost", "Прозрачность")}</span>
            <span className={styles.rangeValue}>{opacity.toFixed(2)}</span>
          </div>
          <input
            className={styles.range}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            disabled={!enabled}
            onChange={(event) => onOpacityChange(Number(event.target.value))}
          />
          <span style={!enabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
            <CheckBox
              label="Блюр за фоном"
              checked={enabled && blurEnabled}
              onChange={onBlurEnabledChange}
            />
          </span>
        </div>
      )}
    </div>
  );
}

interface ChatOverlaySettingsProps {
  alphaBackground: boolean;
  showBadges: boolean;
  showTimestamps: boolean;
  showAvatars: boolean;
  showBttv: boolean;
  showFfz: boolean;
  show7tv: boolean;
  saveCleanVideo: boolean;
  onAlphaBackgroundChange: (value: boolean) => void;
  onShowBadgesChange: (value: boolean) => void;
  onShowTimestampsChange: (value: boolean) => void;
  onShowAvatarsChange: (value: boolean) => void;
  onShowBttvChange: (value: boolean) => void;
  onShowFfzChange: (value: boolean) => void;
  onShow7tvChange: (value: boolean) => void;
  onSaveCleanVideoChange: (value: boolean) => void;
}

export function ChatOverlaySettings({
  alphaBackground,
  showBadges,
  showTimestamps,
  showAvatars,
  showBttv,
  showFfz,
  show7tv,
  saveCleanVideo,
  onAlphaBackgroundChange,
  onShowBadgesChange,
  onShowTimestampsChange,
  onShowAvatarsChange,
  onShowBttvChange,
  onShowFfzChange,
  onShow7tvChange,
  onSaveCleanVideoChange,
}: ChatOverlaySettingsProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.overlaySettingsContainer}>
      <div className={styles.checkboxGroup}>
        <span className={styles.label}>{t("chat_render.otobrazhenie", "Отображение")}</span>
        <div className={styles.checkboxGroupItems}>
          <CheckBox label="Значки" checked={showBadges} onChange={onShowBadgesChange} />
          <CheckBox label="Таймстампы" checked={showTimestamps} onChange={onShowTimestampsChange} />
          <CheckBox label="Аватары" checked={showAvatars} onChange={onShowAvatarsChange} />
        </div>
      </div>
      <div className={styles.checkboxGroup}>
        <span className={styles.label}>{t("chat_render.smayly", "Смайлы")}</span>
        <div className={styles.checkboxGroupItems}>
          <CheckBox label="BTTV" checked={showBttv} onChange={onShowBttvChange} />
          <CheckBox label="FFZ" checked={showFfz} onChange={onShowFfzChange} />
          <CheckBox label="7TV" checked={show7tv} onChange={onShow7tvChange} />
        </div>
      </div>
      <div className={styles.checkboxGroup}>
        <span className={styles.label}>{t("chat_render.vyvod", "Вывод")}</span>
        <div className={styles.checkboxGroupItems}>
          <CheckBox label="Чистая запись" checked={saveCleanVideo} onChange={onSaveCleanVideoChange} />
          <CheckBox label="Альфа-канал" checked={alphaBackground} onChange={onAlphaBackgroundChange} />
        </div>
      </div>
    </div>
  );
}

function buildFontOptions(systemFonts: SystemFont[], activeFamily: string): Array<[string, string]> {
  const names = new Set(systemFonts.map((font) => font.family).filter(Boolean));
  if (activeFamily) names.add(activeFamily);
  if (names.size === 0) {
    ["Inter", "Segoe UI", "Arial"].forEach((name) => names.add(name));
  }
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => [name, name]);
}

function buildWeightOptions(weights: number[] | undefined, currentWeights: number[]): Array<[string, string]> {
  // Always include the currently selected weights, otherwise the <Select>
  // shows a blank value when the active font lacks that weight.
  const source = [...(weights?.length ? weights : [400, 700]), ...currentWeights];
  const normalized = [...new Set(source.map((weight) => normalizeWeight(weight)))].sort((a, b) => a - b);
  return normalized.map((weight) => [String(weight), weightLabel(weight)]);
}

function normalizeWeight(weight: number) {
  return Math.max(100, Math.min(900, Math.round(weight / 100) * 100));
}

function weightLabel(weight: number) {
  if (weight >= 900) return `${weight} Black`;
  if (weight >= 800) return `${weight} ExtraBold`;
  if (weight >= 700) return `${weight} Bold`;
  if (weight >= 600) return `${weight} SemiBold`;
  if (weight >= 500) return `${weight} Medium`;
  if (weight <= 300) return `${weight} Light`;
  return `${weight} Regular`;
}

/**
 * Number input that keeps raw text while typing, so clearing the field does not
 * snap the value to the minimum on every keystroke.
 */
function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  hint,
  className,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  hint?: string;
  className?: string;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText((current) => (Number(current) === value ? current : String(value)));
  }, [value]);

  return (
    <label
      className={`${styles.field} ${className ?? ""}`}
      style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}
    >
      <span className={styles.label}>{label}</span>
      <input
        className={`${styles.input} ${styles.mono}`}
        type="number"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          if (raw === "") return;
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        onBlur={() => setText(String(value))}
      />
      {hint && <span className={styles.fieldHint}>{hint}</span>}
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  hint,
  className,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  hint?: string;
  className?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={`${styles.field} ${className ?? ""}`}>
      <span className={styles.label}>{label}</span>
      <Select className={styles.select} value={value} onValueChange={(value) => onChange(value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option value={optionValue} key={optionValue}>
            {optionLabel}
          </option>
        ))}
      </Select>
      {hint && <span className={styles.fieldHint}>{hint}</span>}
    </label>
  );
}

function CheckBox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className={`${styles.toggleButton} ${checked ? styles.toggleButtonActive : ""}`}>
      <input
        type="checkbox"
        style={{ display: "none" }}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
