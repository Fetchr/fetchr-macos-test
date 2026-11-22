import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import styles from "./ManualRangeForm.module.css";
import type { MuteEdits } from "../hooks/useMuteEdits";

interface ManualRangeFormProps {
  edits: MuteEdits;
  /** false — кнопку раскрытия держит родитель (шапка вида «Текст»). */
  showToggle?: boolean;
}

/** «+ Добавить отрезок вручную»: таймкоды или текущая позиция плеера. */
export function ManualRangeForm({ edits, showToggle = true }: ManualRangeFormProps) {
  const { t } = useTranslation();
  const {
    manualRangeOpen,
    setManualRangeOpen,
    manualStart,
    setManualStart,
    manualEnd,
    setManualEnd,
    manualError,
  } = edits;
  const errorId = "fetchr-mute-manual-range-error";
  if (!showToggle && !manualRangeOpen) return null;
  return (
    <div className={styles.manual}>
      {showToggle && (
      <button
        type="button"
        className={cn(shared.buttonDashed, styles.manualToggle)}
        onClick={() => setManualRangeOpen(!manualRangeOpen)}
        aria-expanded={manualRangeOpen}
      >
        <RedesignIcon name="add" />
        {t("fetchr_mute.manual_add_toggle")}
      </button>
      )}
      {manualRangeOpen && (
        <form
          className={styles.manualForm}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            edits.addManualMoment();
          }}
        >
        <div className={styles.manualRow}>
          <button
            type="button"
            className={shared.ghostButton}
            onClick={edits.markStartAtPlayhead}
            title={t("fetchr_mute.nachalo_fragmenta_tekuschaya_poziciya_pleera")}
          >
            {t("fetchr_mute.manual_start_now")}
          </button>
          <input
            type="text"
            placeholder={t("fetchr_mute.mmss")}
            value={manualStart}
            onChange={(e) => setManualStart(e.target.value)}
            className={cn(shared.input, styles.timeInput)}
            aria-label={t("fetchr_mute.manual_range_start")}
            aria-invalid={manualError?.start || undefined}
            aria-describedby={manualError ? errorId : undefined}
          />
          <span className={styles.dash}>–</span>
          <input
            type="text"
            placeholder={t("fetchr_mute.mmss_2")}
            value={manualEnd}
            onChange={(e) => setManualEnd(e.target.value)}
            className={cn(shared.input, styles.timeInput)}
            aria-label={t("fetchr_mute.manual_range_end")}
            aria-invalid={manualError?.end || undefined}
            aria-describedby={manualError ? errorId : undefined}
          />
          <button
            type="button"
            className={shared.ghostButton}
            onClick={edits.markEndAtPlayhead}
            title={t("fetchr_mute.konec_fragmenta_tekuschaya_poziciya_pleera")}
          >
            {t("fetchr_mute.manual_end_now")}
          </button>
          <button
            type="submit"
            className={shared.secondaryButton}
            title={t("fetchr_mute.zaglushit_ukazannyy_fragment_i_peresobrat")}
          >
            <RedesignIcon name="add" />
            {t("fetchr_mute.manual_mute_button")}
          </button>
        </div>
        {manualError && (
          <p id={errorId} className={styles.fieldError} role="alert">
            {manualError.message}
          </p>
        )}
        </form>
      )}
    </div>
  );
}
