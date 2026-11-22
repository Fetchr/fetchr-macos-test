import type React from "react";
import { useTranslation } from "react-i18next";

import {
  PlaybackSpeedPanel,
  formatSpeed,
} from "@/components/playback-speed-panel";
import { cn } from "@/lib/utils";

import shared from "../shared.module.css";
import styles from "./SpeedMenu.module.css";

interface SpeedMenuProps {
  /** Ref обёртки: клик вне неё закрывает меню (см. useMediaPlayer). */
  speedRef: React.MutableRefObject<HTMLDivElement | null>;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  playbackRate: number;
  onChangeRate: (value: number) => void;
  disabled: boolean;
}

export function SpeedMenu({
  speedRef,
  open,
  setOpen,
  playbackRate,
  onChangeRate,
  disabled,
}: SpeedMenuProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.speedWrap} ref={speedRef}>
      <button
        type="button"
        className={cn(
          shared.ghostButton,
          styles.speedButton,
          open && styles.speedButtonOpen,
        )}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-expanded={open}
        title={t("fetchr_mute.skorost_vosproizvedeniya")}
      >
        {formatSpeed(playbackRate)}
      </button>
      {open && (
        <div className={styles.speedPopover}>
          <PlaybackSpeedPanel
            value={playbackRate}
            onChange={onChangeRate}
            onBack={() => setOpen(false)}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}
