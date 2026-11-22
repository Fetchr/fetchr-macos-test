import { useEffect, useState } from "react";
import type { ChatFontStyle, ChatMessageAnimation } from "@/types/job";
import type { ChatPlatform } from "./ChatPlatformSelector";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./ChatRenderPage.module.css";
import {
  ChatPreviewPlacement,
  normalizeChatPlacement,
  type ChatPlacement,
  type ChatPreviewMessage,
} from "./ChatPreviewPlacement";

interface ChatPositionPanelProps {
  placement: ChatPlacement;
  frameUrl?: string | null;
  onPlacementChange: (placement: ChatPlacement) => void;
  platform: ChatPlatform;
  fontFamily: string;
  fontStyle: ChatFontStyle;
  fontSize: number;
  fontWeight: number;
  usernameFontWeight: number;
  textColor: string;
  outlineEnabled: boolean;
  outlineColor: string;
  outlineThickness: number;
  backgroundEnabled: boolean;
  backgroundOpacity: number;
  backgroundBlurEnabled?: boolean;
  showBadges: boolean;
  showTimestamps?: boolean;
  showAvatars?: boolean;
  showEmotes?: boolean;
  onWidthChange?: (width: number) => void;
  customMessages?: ChatPreviewMessage[] | null;
  messageAnimation?: ChatMessageAnimation;
}

export function ChatPositionPanel({
  placement,
  frameUrl,
  onPlacementChange,
  platform,
  fontFamily,
  fontStyle,
  fontSize,
  fontWeight,
  usernameFontWeight,
  textColor,
  outlineEnabled,
  outlineColor,
  outlineThickness,
  backgroundEnabled,
  backgroundOpacity,
  backgroundBlurEnabled = true,
  showBadges,
  showTimestamps,
  showAvatars,
  showEmotes,
  onWidthChange,
  customMessages,
  messageAnimation,
}: ChatPositionPanelProps) {
  return (
    <ChatPreviewPlacement
      placement={placement}
      frameUrl={frameUrl}
      onPlacementChange={onPlacementChange}
      platform={platform}
      fontFamily={fontFamily}
      fontStyle={fontStyle}
      fontSize={fontSize}
      fontWeight={fontWeight}
      usernameFontWeight={usernameFontWeight}
      textColor={textColor}
      outlineEnabled={outlineEnabled}
      outlineColor={outlineColor}
      outlineThickness={outlineThickness}
      backgroundEnabled={backgroundEnabled}
      backgroundOpacity={backgroundOpacity}
      backgroundBlurEnabled={backgroundBlurEnabled}
      showBadges={showBadges}
      showTimestamps={showTimestamps}
      showAvatars={showAvatars}
      showEmotes={showEmotes}
      onWidthChange={onWidthChange}
      customMessages={customMessages}
      messageAnimation={messageAnimation}
    />
  );
}

interface ChatPlacementFieldsProps {
  placement: ChatPlacement;
  onPlacementChange: (placement: ChatPlacement) => void;
}

export function ChatPlacementFields({ placement, onPlacementChange }: ChatPlacementFieldsProps) {
  const patch = (patchValue: Partial<ChatPlacement>) => {
    // Width and height are independent here: ratio locking happens only during
    // preview drag (hold Shift to unlock). Forcing the ratio in numeric fields
    // made it impossible to type exact dimensions.
    onPlacementChange(normalizeChatPlacement({ ...placement, ...patchValue }));
  };

  return (
    <section className={`${styles.panel} ${styles.placementFieldsPanel}`}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>Размещение чата</div>
        <RedesignIcon name="move" />
      </div>
      <div className={styles.panelBody}>
        <div className={styles.placementGrid}>
          <NumberField label="X" value={placement.x} onChange={(x) => patch({ x })} />
          <NumberField label="Y" value={placement.y} onChange={(y) => patch({ y })} />
          <NumberField label="Ширина" value={placement.width} onChange={(width) => patch({ width })} />
          <NumberField label="Высота" value={placement.height} onChange={(height) => patch({ height })} />
        </div>
        <p className={styles.hint} style={{ marginTop: "var(--fetchr-space-4)" }}>
          В превью размер меняется с сохранением пропорций; зажмите Shift, чтобы менять свободно.
        </p>
      </div>
    </section>
  );
}

/**
 * Number input that keeps raw text while typing, so the field can be cleared
 * and re-typed without snapping to 0 on every keystroke.
 */
function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText((current) => (Number(current) === value ? current : String(value)));
  }, [value]);

  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      <input
        className={`${styles.input} ${styles.mono}`}
        type="number"
        value={text}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          if (raw === "") return;
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        onBlur={() => setText(String(value))}
      />
    </label>
  );
}
