import { useTranslation } from "react-i18next";
import type { BlurEffect, BlurQuality, BlurShape, BlurZone, ImageFit } from "@/types/job";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./SponsorBlurPage.module.css";
import { Select } from "@/components/ui/select";

/** @deprecated shape now lives on the zone itself as `BlurShape`. */
export type SponsorZoneShape = BlurShape;

export interface SponsorZoneUiSettings {
  name: string;
  padding: number;
  adaptiveSize: boolean;
}

interface SponsorZonePropertiesProps {
  zone: BlurZone | null;
  ui: SponsorZoneUiSettings | null;
  /** True when the zone's image_overlay file no longer exists on disk. */
  imageMissing?: boolean;
  onChangeZone: (id: string, patch: Partial<BlurZone>) => void;
  onChangeUi: (id: string, patch: Partial<SponsorZoneUiSettings>) => void;
  onDeleteZone: (id: string) => void;
  onChooseZoneImage: (id: string) => void;
}

const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1080;

export function SponsorZoneProperties({
  zone,
  ui,
  imageMissing = false,
  onChangeZone,
  onChangeUi,
  onDeleteZone,
  onChooseZoneImage,
}: SponsorZonePropertiesProps) {
  const { t } = useTranslation();

  if (!zone || !ui) {
    return (
      <div className={styles.statusBox} style={{ color: "var(--fetchr-color-text-muted)", fontSize: "13px", padding: "12px 0", textAlign: "center" }}>
        {t("sponsor_blur.select_or_add_zone", "Выберите или добавьте зону.")}
      </div>
    );
  }

  const patchNumber = (patch: Partial<BlurZone>) => onChangeZone(zone.id, patch);

  return (
    <div className={styles.propertiesGrid}>
      <label className={styles.field}>
        <span className={styles.label}>{t("sponsor_blur.name", "Имя")}</span>
        <input
          className={styles.input}
          value={ui.name}
          onChange={(event) => onChangeUi(zone.id, { name: event.target.value })}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>{t("sponsor_blur.effect", "Эффект")}</span>
        <Select
          className={styles.select}
          value={zone.effect}
          onValueChange={(value) => onChangeZone(zone.id, { effect: value as BlurEffect })}
        >
          <option value="gaussian_blur">{t("sponsor_blur.blur_effect", "Блюр")}</option>
          <option value="mosaic">{t("sponsor_blur.mosaic_effect", "Мозаика")}</option>
          <option value="image_overlay">{t("sponsor_blur.image_overlay_effect", "Картинка поверх")}</option>
        </Select>
      </label>

      {zone.effect !== "image_overlay" && (
        <label className={styles.field}>
          <span className={styles.label}>
            {t("sponsor_blur.intensity", "Интенсивность")} · {Math.round(zone.intensity)}
          </span>
          <input
            type="range"
            min={1}
            max={zone.effect === "mosaic" ? 80 : 64}
            step={1}
            value={zone.intensity}
            onChange={(event) => patchNumber({ intensity: Number(event.target.value) })}
            className={styles.timelineSlider}
          />
        </label>
      )}

      {zone.effect !== "image_overlay" && (
        <label className={styles.field}>
          <span className={styles.label}>{t("sponsor_blur.quality", "Качество блюра")}</span>
          <Select
            className={styles.select}
            value={zone.quality ?? "balanced"}
            onValueChange={(value) => onChangeZone(zone.id, { quality: value as BlurQuality })}
          >
            <option value="fast">{t("sponsor_blur.quality_fast", "Быстро")}</option>
            <option value="balanced">{t("sponsor_blur.quality_balanced", "Баланс")}</option>
            <option value="high">{t("sponsor_blur.quality_high", "Максимум")}</option>
          </Select>
          <span className={styles.hint}>
            {zone.effect === "mosaic"
              ? t("sponsor_blur.quality_hint_mosaic", "«Максимум» сглаживает края пикселей.")
              : t("sponsor_blur.quality_hint_blur", "«Быстро» размывает на уменьшенной копии — в разы быстрее при большом радиусе.")}
          </span>
        </label>
      )}

      <label className={styles.field}>
        <span className={styles.label}>{t("sponsor_blur.shape", "Форма")}</span>
        <Select
          className={styles.select}
          value={zone.shape ?? "rectangle"}
          onValueChange={(value) => onChangeZone(zone.id, { shape: value as BlurShape })}
          disabled={zone.effect === "image_overlay"}
        >
          <option value="rectangle">{t("sponsor_blur.shape_rectangle", "Прямоугольник")}</option>
          <option value="ellipse">{t("sponsor_blur.shape_ellipse", "Эллипс")}</option>
        </Select>
      </label>

      {zone.effect !== "image_overlay" && (
        <label className={styles.field}>
          <span className={styles.label}>
            {t("sponsor_blur.edge_softness", "Мягкость краёв")} · {zone.edge_softness ?? 0}px
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.floor(Math.min(zone.width, zone.height) / 2))}
            step={1}
            value={Math.min(zone.edge_softness ?? 0, Math.floor(Math.min(zone.width, zone.height) / 2))}
            onChange={(event) => patchNumber({ edge_softness: Number(event.target.value) })}
            className={styles.timelineSlider}
          />
        </label>
      )}

      <label className={styles.field}>
        <span className={styles.label}>
          {t("sponsor_blur.opacity", "Непрозрачность")} · {Math.round((zone.opacity ?? 1) * 100)}%
        </span>
        <input
          type="range"
          min={10}
          max={100}
          step={1}
          value={Math.round((zone.opacity ?? 1) * 100)}
          onChange={(event) => patchNumber({ opacity: Number(event.target.value) / 100 })}
          className={styles.timelineSlider}
        />
      </label>

      <div className={styles.field}>
        <span className={styles.label}>{t("sponsor_blur.position_size", "Позиция и размер")}</span>
        <div className={styles.sliderStack}>
          <PositionSlider label="X" value={zone.x} min={0} max={DESIGN_WIDTH - zone.width} onChange={(x) => patchNumber({ x })} />
          <PositionSlider label="Y" value={zone.y} min={0} max={DESIGN_HEIGHT - zone.height} onChange={(y) => patchNumber({ y })} />
          <PositionSlider label={t("sponsor_blur.width", "Ширина")} value={zone.width} min={24} max={DESIGN_WIDTH - zone.x} onChange={(width) => patchNumber({ width })} />
          <PositionSlider label={t("sponsor_blur.height", "Высота")} value={zone.height} min={24} max={DESIGN_HEIGHT - zone.y} onChange={(height) => patchNumber({ height })} />
        </div>
      </div>

      {zone.tracking?.keyframes.length ? (
        <>
          <div className={styles.statusBox}>
            {t("sponsor_blur.tracking_stats", {
              count: zone.tracking.keyframes.length,
              time: formatTime(zone.tracking.start_time_sec),
              defaultValue: `Трекинг: {{count}} keyframes · {{time}}`
            })}
            {zone.tracking.end_time_sec != null ? `-${formatTime(zone.tracking.end_time_sec)}` : ""}
          </div>
          <label className={styles.toggleRow}>
            <span>{t("sponsor_blur.use_tracking", "Использовать трекинг")}</span>
            <input
              type="checkbox"
              checked={zone.tracking.enabled}
              onChange={(event) =>
                onChangeZone(zone.id, {
                  tracking: zone.tracking ? { ...zone.tracking, enabled: event.target.checked } : null,
                })
              }
            />
          </label>
          <button className={styles.button} type="button" onClick={() => onChangeZone(zone.id, { tracking: null })}>
            <RedesignIcon name="reset" />
            {t("sponsor_blur.reset_tracking", "Сбросить трекинг")}
          </button>
        </>
      ) : null}

      {zone.effect === "image_overlay" && (
        <>
          <div style={{ display: "flex", gap: 4, alignItems: "end" }}>
            <label className={styles.field} style={{ flex: 1 }}>
              <span className={styles.label}>{t("sponsor_blur.image_path", "Путь к картинке")}</span>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={zone.image_path ?? ""}
                onChange={(event) => onChangeZone(zone.id, { image_path: event.target.value })}
              />
            </label>
            <button className={styles.button} style={{ height: 38, flex: "0 0 auto" }} type="button" onClick={() => onChooseZoneImage(zone.id)}>
              <RedesignIcon name="image" />
              {t("sponsor_blur.file", "Файл")}
            </button>
          </div>
          {imageMissing && (
            <div className={styles.error}>
              {t("sponsor_blur.image_missing", "Файл картинки не найден — зона будет пропущена при рендере.")}
            </div>
          )}
          <label className={styles.field}>
            <span className={styles.label}>{t("sponsor_blur.image_fit", "Вписывание")}</span>
            <Select
              className={styles.select}
              value={zone.image_fit ?? "contain"}
              onValueChange={(value) => onChangeZone(zone.id, { image_fit: value as ImageFit })}
            >
              <option value="contain">{t("sponsor_blur.fit_contain", "Вместить (contain)")}</option>
              <option value="cover">{t("sponsor_blur.fit_cover", "Заполнить (cover)")}</option>
              <option value="stretch">{t("sponsor_blur.fit_stretch", "Растянуть (stretch)")}</option>
            </Select>
          </label>
        </>
      )}

      <button className={`${styles.button} ${styles.dangerButton}`} type="button" onClick={() => onDeleteZone(zone.id)}>
        <RedesignIcon name="trash" />
        {t("sponsor_blur.delete_zone", "Удалить зону")}
      </button>
    </div>
  );
}

interface PositionSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

/** Ползунок с числом рядом: тянуть быстро, а точное значение можно вписать. */
function PositionSlider({ label, value, min, max, onChange }: PositionSliderProps) {
  const upper = Math.max(min + 1, Math.round(max));
  return (
    <label className={styles.sliderRow}>
      <span className={styles.sliderLabel}>{label}</span>
      <input
        type="range"
        min={min}
        max={upper}
        step={1}
        value={Math.min(upper, Math.max(min, value))}
        onChange={(event) => onChange(Number(event.target.value))}
        className={styles.timelineSlider}
      />
      <input
        type="number"
        min={min}
        max={upper}
        value={value}
        onChange={(event) => {
          const parsed = Math.round(Number(event.target.value));
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        className={`${styles.input} ${styles.mono} ${styles.sliderNumber}`}
        aria-label={label}
      />
    </label>
  );
}

function formatTime(value: number) {
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
