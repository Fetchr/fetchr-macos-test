import type { TwitchPublicVodPage } from "@/services/m3u8/m3u8DiscoveryTypes";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { RemoteImage } from "@/ui/redesign/media/RemoteImage";

import styles from "./M3U8FinderPage.module.css";

interface PublicVodSearchPanelProps {
  login: string;
  loading: boolean;
  error?: string | null;
  page?: TwitchPublicVodPage | null;
  presetHistory?: string[];
  onLoginChange: (value: string) => void;
  onSearch: () => void;
}

export function PublicVodSearchPanel({
  login,
  loading,
  error,
  page,
  presetHistory = [],
  onLoginChange,
  onSearch,
}: PublicVodSearchPanelProps) {
  const broadcaster = page?.broadcaster;

  return (
    <section style={{ minWidth: 0 }}>
      <div className={styles.panelBody} style={{ paddingBottom: 0 }}>
        <div className={styles.formGrid}>
          <div className={styles.formRow}>
            <label className={styles.field}>
              <span className={styles.label}>Никнейм</span>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={login}
                placeholder="Например: riotgames"
                onChange={(event) => onLoginChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !loading) onSearch();
                }}
              />
            </label>
            <div style={{ display: "flex", gap: "8px", alignItems: "end" }}>
              <button className={`${styles.button} ${styles.primaryButton}`} type="button" onClick={onSearch} disabled={loading} aria-busy={loading}>
                <RedesignIcon name={loading ? "loading" : "download"} className={loading ? "animate-spin" : undefined} />
                Загрузить VOD
              </button>
            </div>
          </div>

          {presetHistory.length > 0 && (
            <div className={styles.historyRow}>
              {presetHistory.slice(0, 6).map((item) => (
                <button className={styles.historyChip} type="button" key={item} onClick={() => onLoginChange(item)}>
                  {item}
                </button>
              ))}
            </div>
          )}

          {error && <div className={styles.errorBox}>{error}</div>}
        </div>

        {broadcaster && (
          <div className={styles.profileStrip}>
            <RemoteImage
              className={styles.avatar}
              src={broadcaster.profileImageUrl}
              alt={broadcaster.displayName}
              fallbackLabel={broadcaster.displayName || broadcaster.login}
              platform="twitch"
              platformBadge=""
              aspectRatio="1 / 1"
            />
            <div className={styles.profileText}>
              <div className={styles.profileName}>{broadcaster.displayName}</div>
              <div className={styles.profileMeta}>@{broadcaster.login} · ID {broadcaster.id}</div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
