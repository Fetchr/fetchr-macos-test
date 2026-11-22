import type { CSSProperties, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import type { BlurZone } from "@/types/job";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./SponsorBlurPage.module.css";

interface SponsorZoneListProps {
  zones: BlurZone[];
  selectedId: string | null;
  getZoneName: (zone: BlurZone, index: number) => string;
  onSelectZone: (id: string) => void;
  onChangeZone: (id: string, patch: Partial<BlurZone>) => void;
  hideHeader?: boolean;
}

const ZONE_COLORS = ["#a78bfa", "#2fd49b", "#f2a93b", "#3d7dff", "#f0506e", "#31d0c5"];

export function SponsorZoneList({
  zones,
  selectedId,
  getZoneName,
  onSelectZone,
  onChangeZone,
  hideHeader = false,
}: SponsorZoneListProps) {
  const { t } = useTranslation();

  const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelectZone(id);
  };

  return (
    <section className={hideHeader ? styles.panelNoBorder : styles.panel}>
      {!hideHeader && (
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>
            {t("sponsor_blur.zones_title", { count: zones.length, defaultValue: `Зоны (${zones.length})` })}
          </div>
          <RedesignIcon name="blur" />
        </div>
      )}
      <div className={hideHeader ? styles.list : `${styles.panelBody} ${styles.list}`}>
        {zones.length === 0 ? (
          <div className={styles.statusBox}>
            {t("sponsor_blur.no_zones_hint", "Зон пока нет. Добавьте область поверх кадра.")}
          </div>
        ) : (
          zones.map((zone, index) => (
            <div
              key={zone.id}
              role="button"
              tabIndex={0}
              className={`${styles.zoneRow} ${selectedId === zone.id ? styles.zoneRowActive : ""}`}
              style={{ "--zone-color": ZONE_COLORS[index % ZONE_COLORS.length] } as CSSProperties}
              onClick={() => onSelectZone(zone.id)}
              onKeyDown={(event) => handleRowKeyDown(event, zone.id)}
            >
              <span className={styles.swatch} />
              <span className={styles.zoneRowText}>
                <span className={styles.zoneRowName}>{getZoneName(zone, index)}</span>
              </span>
              <button
                type="button"
                className={styles.zoneRowIconButton}
                title={zone.enabled ? t("sponsor_blur.hide_zone_tooltip", "Скрыть зону") : t("sponsor_blur.show_zone_tooltip", "Показать зону")}
                onClick={(event) => {
                  event.stopPropagation();
                  onChangeZone(zone.id, { enabled: !zone.enabled });
                }}
              >
                <RedesignIcon name={zone.enabled ? "visible" : "hidden"} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
