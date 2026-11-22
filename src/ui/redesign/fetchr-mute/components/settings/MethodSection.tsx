import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import type { FetchrMuteCensorMethod } from "@/types/job";

import shared from "../../shared.module.css";
import styles from "./SettingsRail.module.css";
import { fileNameFromPath } from "../../fetchrMuteSettings";

interface MethodSectionProps {
  censorMethod: FetchrMuteCensorMethod;
  customSoundPath: string | null;
  onSelect: (method: FetchrMuteCensorMethod) => void;
  onChooseCustomSound: () => void;
}

/** «Чем заменить мат»: тишина, писк или свой звук. */
export function MethodSection({
  censorMethod,
  customSoundPath,
  onSelect,
  onChooseCustomSound,
}: MethodSectionProps) {
  const { t } = useTranslation();
  const methods: ReadonlyArray<{
    id: FetchrMuteCensorMethod;
    label: string;
    detail?: string;
  }> = [
    {
      id: "mute",
      label: t("purevoice.method_mute"),
    },
    {
      id: "beep",
      label: t("purevoice.method_beep"),
    },
    {
      id: "custom",
      label: t("purevoice.method_custom"),
      detail: customSoundPath ? fileNameFromPath(customSoundPath) : undefined,
    },
  ];

  return (
    <section className={shared.sidebarSection}>
      <h2 className={shared.sidebarTitle}>
        {t("purevoice.censor_method")}
      </h2>
      <div
        className={styles.methods}
        role="radiogroup"
        aria-label={t("fetchr_mute.method_aria")}
      >
        {methods.map((method) => {
          const active = censorMethod === method.id;
          return (
            <button
              key={method.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={cn(styles.method, active && styles.methodActive)}
              onClick={() => onSelect(method.id)}
            >
              {method.detail ? (
                <span className={styles.methodText}>
                  <span className={styles.methodName}>{method.label}</span>
                  <span className={styles.methodHint}>{method.detail}</span>
                </span>
              ) : (
                <span className={styles.methodName}>{method.label}</span>
              )}
            </button>
          );
        })}
      </div>
      {censorMethod === "custom" && (
        <button
          className={shared.secondaryButton}
          type="button"
          onClick={onChooseCustomSound}
        >
          <RedesignIcon name="folder" />
          {customSoundPath
            ? t("fetchr_mute.smenit_zvuk")
            : t("purevoice.choose_custom_sound")}
        </button>
      )}
      <p className={shared.sidebarHint}>
        {t("fetchr_mute.raspoznaetsya_russkaya_rech")}
      </p>
    </section>
  );
}
