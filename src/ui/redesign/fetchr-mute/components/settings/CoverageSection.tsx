import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { cn } from "@/lib/utils";

import shared from "../../shared.module.css";
import styles from "./SettingsRail.module.css";
import { COVERAGE_OPTIONS, type CoverageOption } from "../../constants";

function coverageTexts(t: TFunction): Record<CoverageOption, { label: string; hint: string }> {
  return {
    30: { label: t("fetchr_mute.coverage_30_label"), hint: t("fetchr_mute.coverage_30_hint") },
    50: { label: t("fetchr_mute.coverage_50_label"), hint: t("fetchr_mute.coverage_50_hint") },
    75: { label: t("fetchr_mute.coverage_75_label"), hint: t("fetchr_mute.coverage_75_hint") },
    100: { label: t("fetchr_mute.coverage_100_label"), hint: t("fetchr_mute.coverage_100_hint") },
  };
}

interface CoverageSectionProps {
  coveragePercent: number;
  onSelect: (value: number) => void;
}

/** «Сколько заглушать»: доля слова под мутом. */
export function CoverageSection({ coveragePercent, onSelect }: CoverageSectionProps) {
  const { t } = useTranslation();
  const texts = coverageTexts(t);
  const preset = COVERAGE_OPTIONS.find((value) => value === coveragePercent);
  const currentHint =
    preset !== undefined
      ? texts[preset].hint
      : t("fetchr_mute.coverage_custom_current", { value: coveragePercent });
  return (
    <section className={shared.sidebarSection}>
      <h2 className={shared.sidebarTitle}>{t("fetchr_mute.coverage_title")}</h2>
      <div
        className={styles.coverage}
        role="radiogroup"
        aria-label={t("fetchr_mute.coverage_aria")}
      >
        {COVERAGE_OPTIONS.map((value) => {
          const active = coveragePercent === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              title={texts[value].hint}
              className={cn(styles.coverageOption, active && styles.coverageOptionActive)}
              onClick={() => {
                if (active) return;
                onSelect(value);
              }}
            >
              <b>{value}%</b>
              <span>{texts[value].label}</span>
            </button>
          );
        })}
      </div>
      <p className={shared.sidebarHint} aria-live="polite">
        {currentHint}
      </p>
    </section>
  );
}
