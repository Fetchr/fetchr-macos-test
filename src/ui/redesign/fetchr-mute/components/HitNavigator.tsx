import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import styles from "./PlayerControls.module.css";
import type { HitNavigator as HitNavigatorState } from "../hooks/useHitNavigator";

interface HitNavigatorProps {
  navigator: HitNavigatorState;
  disabled: boolean;
}

/** «‹ мат N из M ›»: переход к предыдущему и следующему хиту. */
export function HitNavigator({ navigator, disabled }: HitNavigatorProps) {
  const { t } = useTranslation();
  const { current, total } = navigator;
  // current === -1 при непустом списке — плейхед после последнего хита; «Назад» ведёт к нему.
  const label =
    total === 0
      ? t("fetchr_mute.hit_nav_empty")
      : current === -1
        ? t("fetchr_mute.hit_nav_after_last", { total })
        : t("fetchr_mute.hit_nav", { n: current + 1, count: total });
  return (
    <div className={styles.hitNav} role="group" aria-label={t("fetchr_mute.hit_nav_aria")}>
      <button
        type="button"
        className={cn(shared.ghostButton, styles.hitNavButton)}
        onClick={navigator.prev}
        disabled={disabled || !navigator.canPrev}
        aria-label={t("fetchr_mute.hit_prev")}
        title={t("fetchr_mute.hit_prev")}
      >
        <RedesignIcon name="chevronLeft" />
      </button>
      <span className={styles.hitNavLabel}>{label}</span>
      <button
        type="button"
        className={cn(shared.ghostButton, styles.hitNavButton)}
        onClick={navigator.next}
        disabled={disabled || !navigator.canNext}
        aria-label={t("fetchr_mute.hit_next")}
        title={t("fetchr_mute.hit_next")}
      >
        <RedesignIcon name="chevronRight" />
      </button>
    </div>
  );
}
