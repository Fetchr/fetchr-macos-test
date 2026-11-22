import { PlatformIcon } from "@/ui/redesign/icons/iconMap";
import { RemoteImage } from "@/ui/redesign/media/RemoteImage";

import styles from "./LiveRecorderPage.module.css";

interface LiveThumbProps {
  thumbnail?: string | null;
  platform: string;
  /** Запись идёт: на кадре горит красная метка LIVE */
  live: boolean;
}

/**
 * Кадр записи слева в карточке, как в промо-ролике. Обложки нет — вместо
 * неё значок платформы на тонированной подложке, чтобы карточки не
 * выглядели пустыми и оставались одной высоты.
 */
export function LiveThumb({ thumbnail, platform, live }: LiveThumbProps) {
  return (
    <div className={styles.liveThumb} data-platform={platform} aria-hidden>
      {thumbnail ? (
        <RemoteImage className={styles.liveThumbImage} src={thumbnail} alt="" platform={platform} aspectRatio="16 / 9" />
      ) : (
        <PlatformIcon platform={platform} className={styles.liveThumbIcon} strokeWidth={1.6} />
      )}
      {live && (
        <span className={styles.livePill}>
          <span className={styles.livePillDot} />
          LIVE
        </span>
      )}
    </div>
  );
}
