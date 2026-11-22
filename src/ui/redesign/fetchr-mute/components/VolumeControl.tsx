import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../shared.module.css";
import styles from "./PlayerControls.module.css";
import type { MediaPlayer } from "../hooks/useMediaPlayer";

interface VolumeControlProps {
  player: MediaPlayer;
  disabled: boolean;
}

/**
 * Иконка звука открывает поповер: кнопка «Выключить звук» и ползунок громкости.
 * Esc и клик снаружи закрывают; при открытии фокус уходит в ползунок.
 */
export function VolumeControl({ player, disabled }: VolumeControlProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const sliderRef = useRef<HTMLInputElement | null>(null);
  const popoverId = useId();
  const { isMuted, volume } = player;
  const level = isMuted ? 0 : volume;
  const percent = Math.round(level * 100);
  const muteLabel = isMuted ? t("fetchr_mute.unmute") : t("fetchr_mute.mute_sound");
  const triggerLabel = t("fetchr_mute.volume_open", { value: percent });

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    sliderRef.current?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      const focusInside = wrapRef.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (focusInside) triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      className={styles.volumeWrap}
      ref={wrapRef}
      onBlur={(event) => {
        // Tab увёл фокус за пределы контрола — поповер закрываем.
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={cn(shared.iconButton, open && styles.volumeTriggerOpen)}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popoverId : undefined}
        title={triggerLabel}
      >
        <RedesignIcon name={isMuted || volume === 0 ? "mute" : "audio"} />
      </button>
      {open && (
        <div
          id={popoverId}
          className={styles.volumePopover}
          role="dialog"
          aria-label={t("fetchr_mute.volume")}
        >
          <button
            type="button"
            className={shared.iconButton}
            onClick={player.toggleMute}
            aria-label={muteLabel}
            aria-pressed={isMuted}
            title={muteLabel}
          >
            <RedesignIcon name={isMuted ? "mute" : "audio"} />
          </button>
          <input
            ref={sliderRef}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={level}
            onChange={player.handleVolumeChange}
            className={styles.volume}
            aria-label={t("fetchr_mute.volume")}
            aria-valuetext={`${percent}%`}
          />
          <span className={styles.volumeValue} aria-hidden="true">
            {percent}%
          </span>
        </div>
      )}
    </div>
  );
}
