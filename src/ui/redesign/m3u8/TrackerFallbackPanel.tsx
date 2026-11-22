import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./M3U8FinderPage.module.css";

interface TrackerFallbackPanelProps {
  sourceUrl: string;
  loading: boolean;
  error?: string | null;
  onSourceUrlChange: (value: string) => void;
  onPaste: () => void;
  onFetchMetadata: () => void;
}

export function TrackerFallbackPanel({
  sourceUrl,
  loading,
  error,
  onSourceUrlChange,
  onPaste,
  onFetchMetadata,
}: TrackerFallbackPanelProps) {
  return (
    <section style={{ minWidth: 0 }}>
      <div className={styles.panelBody} style={{ paddingBottom: 0 }}>
        <div className={styles.formGrid}>
          <div className={styles.formRow}>
            <label className={styles.field}>
              <span className={styles.label}>Tracker URL</span>
              <span className={styles.iconField}>
                <RedesignIcon name="link" />
                <input
                  className={styles.mono}
                  value={sourceUrl}
                  placeholder="Вставьте ссылку на twitchtracker / streamscharts / sullygnome"
                  onChange={(event) => onSourceUrlChange(event.target.value)}
                />
              </span>
            </label>
            <div className={styles.trackerActions}>
              <button
                className={`${styles.button} ${styles.iconButton}`}
                type="button"
                onClick={onPaste}
                title="Вставить"
                aria-label="Вставить"
              >
                <RedesignIcon name="clipboard" />
              </button>
              <button
                className={`${styles.button} ${styles.iconButton}`}
                type="button"
                onClick={onFetchMetadata}
                disabled={!sourceUrl.trim() || loading}
                title="Подтянуть"
                aria-label="Подтянуть"
               aria-busy={loading}>
                <RedesignIcon name={loading ? "loading" : "external"} className={loading ? "animate-spin" : undefined} />
              </button>
            </div>
          </div>

          {error && <div className={styles.errorBox}>{error}</div>}
        </div>
      </div>
    </section>
  );
}
