import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ChatFontStyle, ChatMessageAnimation } from "@/types/job";
import type { ChatPlatform } from "./ChatPlatformSelector";
import { toRenderParts } from "@/lib/chatFragments";
import type { VpsChatFragment } from "@/lib/ipc";

import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./ChatRenderPage.module.css";

export interface ChatPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
}

export interface ChatPreviewMessage {
  id: number;
  user: string;
  color: string;
  badge: string;
  text: string;
  emote?: string;
  /** Real message parts, when the preview is fed from a loaded chat JSON.
   *  Carries emote images; `text` stays as the fallback for the demo pool. */
  fragments?: VpsChatFragment[];
}

interface ChatPreviewPlacementProps {
  placement: ChatPlacement;
  frameUrl?: string | null;
  constrainToBounds?: boolean;
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
  /** Same entry effect as the final render, so the choice is visible right away. */
  messageAnimation?: ChatMessageAnimation;
}

type DragState =
  | {
      mode: "move";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startPlacement: ChatPlacement;
    }
  | {
      mode: "resize";
      handle: ResizeHandle;
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startPlacement: ChatPlacement;
    };

type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const MIN_CHAT_WIDTH = 120;
export const MIN_CHAT_HEIGHT = 80;

/** Chat JSON files can hold tens of thousands of messages — rendering all of them
 * in the preview DOM freezes the page, so only the tail is shown. */
export const MAX_PREVIEW_MESSAGES = 30;

const HANDLE_CONFIG: Array<{ id: ResizeHandle; className: string; label: string }> = [
  { id: "n", className: styles.resizeN, label: "Изменить высоту сверху" },
  { id: "s", className: styles.resizeS, label: "Изменить высоту снизу" },
  { id: "e", className: styles.resizeE, label: "Изменить ширину справа" },
  { id: "w", className: styles.resizeW, label: "Изменить ширину слева" },
  { id: "ne", className: styles.resizeNE, label: "Изменить размер сверху справа" },
  { id: "nw", className: styles.resizeNW, label: "Изменить размер сверху слева" },
  { id: "se", className: styles.resizeSE, label: "Изменить размер снизу справа" },
  { id: "sw", className: styles.resizeSW, label: "Изменить размер снизу слева" },
];

const twitchMessages = [
  { user: "sllseZ", color: "#86ef2f", badge: "", text: "да", emote: "" },
  { user: "palmerok", color: "#00f58a", badge: "", text: "++++", emote: "" },
  { user: "plos_vibe", color: "#8ccfff", badge: "", text: "не твой уровень", emote: "" },
  { user: "denchik668", color: "#ff66c8", badge: "", text: "жёстко", emote: "" },
  { user: "ch4dqq", color: "#ff6bdd", badge: "", text: "Диман ты со львом жил неделю он тебя промыть должен был чтобы только на премьере гонял", emote: "" },
  { user: "morfaze_", color: "#f9a8d4", badge: "3M", text: "кирик", emote: "" },
  { user: "maammon666", color: "#86efac", badge: "SUB", text: ")", emote: "Итоги 2024" },
  { user: "antoxanotdance", color: "#a78bfa", badge: "GLHF", text: "А ЧТО БУДЕТ НА ВЫХОДЕ ))", emote: "" },
  { user: "vvrnkaaz", color: "#93c5fd", badge: "", text: "а там разве можно курить?", emote: "" },
  { user: "eby_sholi", color: "#34d399", badge: "", text: "это и есть стримфут", emote: "" },
  { user: "datuper", color: "#60a5fa", badge: "MOD", text: "Вау", emote: "" },
  { user: "lensone1", color: "#38bdf8", badge: "7TV", text: "всем привет чат, друзья hi", emote: "" },
];

const kickMessages = [
  { user: "green_chat", color: "#53fc18", badge: "VIP", text: "Kick replay style preview", emote: "" },
  { user: "viewer777", color: "#a3e635", badge: "", text: "чат тоже летит быстро", emote: "" },
  { user: "mod_kick", color: "#22c55e", badge: "MOD", text: "JSON готов к рендеру", emote: "" },
  { user: "hype_user", color: "#bbf7d0", badge: "", text: "зелёная стилистика Kick", emote: "" },
  { user: "chatflow", color: "#86efac", badge: "", text: "фон и толщина меняются live", emote: "" },
];

const wtvMessages = [
  { user: "Streamer", color: "#b173ff", badge: "OWN", text: "превью в стиле W.TV", emote: "" },
  { user: "ArmorOfWildfire", color: "#ff2681", badge: "", text: "цвета ников как на сайте", emote: "" },
  { user: "mod_w", color: "#26ff81", badge: "MOD", text: "чат пишется во время эфира", emote: "" },
  { user: "Zimniajk", color: "#4df4ff", badge: "", text: "Prayge", emote: "" },
  { user: "viewer_w", color: "#ffe601", badge: "", text: "подложка и шрифт Inter", emote: "" },
];

const PREVIEW_POOLS = { twitch: twitchMessages, kick: kickMessages, wtv: wtvMessages };

const SAMPLE_TIMESTAMP = "12:34";

export function ChatPreviewPlacement({
  placement,
  frameUrl,
  constrainToBounds = true,
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
  showTimestamps = false,
  showAvatars = false,
  showEmotes = true,
  onWidthChange,
  customMessages,
  messageAnimation,
}: ChatPreviewPlacementProps) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const left = (placement.x / placement.outputWidth) * 100;
  const top = (placement.y / placement.outputHeight) * 100;
  const width = (placement.width / placement.outputWidth) * 100;
  const height = (placement.height / placement.outputHeight) * 100;
  const scale = displaySize.width ? displaySize.width / placement.outputWidth : 1;
  const measured = displaySize.width > 0;
  const guides = useMemo(() => alignmentGuides(placement), [placement]);

  const [messages, setMessages] = useState<ChatPreviewMessage[]>([]);
  const messageIdRef = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (customMessages) return;
    const pool = PREVIEW_POOLS[platform];
    const initial: ChatPreviewMessage[] = [];
    for (let i = 0; i < 3; i++) {
      const msg = pool[Math.floor(Math.random() * pool.length)];
      initial.push({
        id: messageIdRef.current++,
        user: msg.user,
        color: msg.color,
        badge: msg.badge,
        text: msg.text,
        emote: msg.emote,
      });
    }
    setMessages(initial);

    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      const msg = pool[Math.floor(Math.random() * pool.length)];
      setMessages((prev) => {
        const next = [
          ...prev,
          {
            id: messageIdRef.current++,
            user: msg.user,
            color: msg.color,
            badge: msg.badge,
            text: msg.text,
            emote: msg.emote,
          },
        ];
        if (next.length > 15) {
          next.shift();
        }
        return next;
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [platform, customMessages]);

  // Смена эффекта проигрывает его заново на последнем сообщении: в загруженном
  // JSON новые сообщения не приходят, иначе выбор было бы не увидеть.
  const [replay, setReplay] = useState(0);
  useEffect(() => {
    setReplay((value) => value + 1);
  }, [messageAnimation]);

  const visibleMessages = useMemo(
    () => (customMessages ?? messages).slice(-MAX_PREVIEW_MESSAGES),
    [customMessages, messages],
  );

  // Follow the newest message, but stop fighting the user the moment they
  // scroll up to read something older.
  const pinnedRef = useRef(true);
  useEffect(() => {
    const container = containerRef.current;
    if (container && pinnedRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [visibleMessages]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const update = () => {
      const rect = frame.getBoundingClientRect();
      setDisplaySize({ width: rect.width, height: rect.height });
      onWidthChange?.(rect.width);
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [onWidthChange]);

  const commitPlacement = (next: ChatPlacement) => {
    onPlacementChange(normalizeChatPlacement(next, constrainToBounds));
  };

  const startMove = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      mode: "move",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPlacement: placement,
    };
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>, handle: ResizeHandle) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      mode: "resize",
      handle,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPlacement: placement,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const frame = frameRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !frame) return;

    const rect = frame.getBoundingClientRect();
    const scaleX = placement.outputWidth / Math.max(1, rect.width);
    const scaleY = placement.outputHeight / Math.max(1, rect.height);
    const dx = Math.round((event.clientX - drag.startClientX) * scaleX);
    const dy = Math.round((event.clientY - drag.startClientY) * scaleY);

    if (drag.mode === "move") {
      commitPlacement({
        ...drag.startPlacement,
        x: drag.startPlacement.x + dx,
        y: drag.startPlacement.y + dy,
      });
      return;
    }

    commitPlacement(resizePlacement(drag.startPlacement, drag.handle, dx, dy, !event.shiftKey));
  };

  const stopPointerAction = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer capture may already be released */
    }
  };

  const onChatBoxKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1;
    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowLeft") dx = -step;
    else if (event.key === "ArrowRight") dx = step;
    else if (event.key === "ArrowUp") dy = -step;
    else if (event.key === "ArrowDown") dy = step;
    else return;
    event.preventDefault();
    commitPlacement({ ...placement, x: placement.x + dx, y: placement.y + dy });
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, handle: ResizeHandle) => {
    const step = event.shiftKey ? 10 : 1;
    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowLeft") dx = -step;
    else if (event.key === "ArrowRight") dx = step;
    else if (event.key === "ArrowUp") dy = -step;
    else if (event.key === "ArrowDown") dy = step;
    else return;
    event.preventDefault();
    event.stopPropagation();
    commitPlacement(resizePlacement(placement, handle, dx, dy, !event.altKey));
  };

  return (
    <div className={styles.previewShell}>
      <div
        ref={frameRef}
        className={styles.previewFrame}
        style={{
          aspectRatio: `${placement.outputWidth} / ${placement.outputHeight}`,
          ["--preview-ar" as string]: placement.outputWidth / placement.outputHeight,
        }}
        onPointerMove={onPointerMove}
        onPointerUp={stopPointerAction}
        onPointerCancel={stopPointerAction}
      >
        {frameUrl ? (
          <img className={styles.frameImage} src={frameUrl} alt="" />
        ) : (
          <div className={styles.gridBackdrop} />
        )}
        {guides.vertical && <div className={`${styles.alignmentGuide} ${styles.alignmentGuideV}`} />}
        {guides.horizontal && <div className={`${styles.alignmentGuide} ${styles.alignmentGuideH}`} />}
        <div
          className={styles.chatBox}
          style={{
            left: `${left}%`,
            top: `${top}%`,
            width: `${width}%`,
            height: `${height}%`,
            backgroundColor: backgroundEnabled ? `rgba(0, 0, 0, ${backgroundOpacity})` : "transparent",
            // Mirror the frosted-glass backdrop the renderer applies behind the chat
            // (ffmpeg gblur sigma 18 at output resolution → scaled to preview size).
            backdropFilter: backgroundEnabled && backgroundBlurEnabled ? `blur(${Math.max(1, 18 * scale)}px)` : undefined,
            WebkitBackdropFilter: backgroundEnabled && backgroundBlurEnabled ? `blur(${Math.max(1, 18 * scale)}px)` : undefined,
            padding: `${Math.max(2, 6 * scale)}px`,
            display: "flex",
            flexDirection: "column",
          }}
          onPointerDown={startMove}
          onKeyDown={onChatBoxKeyDown}
          tabIndex={0}
          role="group"
          aria-label={`Область чата: ${placement.width}×${placement.height}, позиция ${placement.x}, ${placement.y}. Стрелки — перемещение, Shift — быстрее.`}
          title={t("chat_render.peretaskivayte_dlya_peremescheniya_pri_resiz", "Перетаскивайте для перемещения. При resize зажмите Shift, чтобы менять размер свободно (без сохранения пропорций).")}
        >
          <div
            className={styles.chatBoxHeader}
            style={{
              fontSize: `${Math.max(8, 10 * scale)}px`,
              padding: `${Math.max(2, 3 * scale)}px ${Math.max(3, 5 * scale)}px`,
              left: `${Math.max(2, 6 * scale)}px`,
              top: `${Math.max(2, 6 * scale)}px`,
              zIndex: 10,
            }}
          >
            <RedesignIcon name="move" style={{ width: `${Math.max(8, 10 * scale)}px`, height: `${Math.max(8, 10 * scale)}px` }} />
            <span>Chat</span>
            <span className={styles.chatBoxHeaderMeta}>
              {placement.width}×{placement.height} · {placement.x},{placement.y}
            </span>
          </div>

          <div
            ref={containerRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            className={styles.chatBoxMessageContainer}
            data-appear={messageAnimation ?? "none"}
            style={{
              paddingTop: `${Math.max(16, 22 * scale)}px`,
              gap: `${Math.max(1, 3 * scale)}px`,
              visibility: measured ? "visible" : "hidden",
            }}
          >
            {visibleMessages.map((message, index) => {
              const scaledFontSize = Math.max(3, fontSize * scale);
              const scaledOutlineThickness = outlineThickness * scale;
              const outlineShadow = outlineEnabled
                ? `0 0 ${scaledOutlineThickness}px ${outlineColor}, 0 1px ${scaledOutlineThickness}px ${outlineColor}`
                : "none";
              const messageStyle = {
                color: textColor,
                fontFamily,
                fontSize: `${scaledFontSize}px`,
                fontStyle,
                fontWeight,
                textShadow: outlineShadow,
              };

              return (
                <div
                  className={`${styles.chatPreviewMessage} ${styles.chatPreviewMessageNew}`}
                  key={index === visibleMessages.length - 1 ? `${message.id}:${replay}` : message.id}
                >
                  {showTimestamps && (
                    <span
                      className={styles.chatPreviewTimestamp}
                      style={{ fontSize: `${Math.max(3, 9 * scale)}px` }}
                    >
                      {SAMPLE_TIMESTAMP}
                    </span>
                  )}
                  {showAvatars && (
                    <span
                      className={styles.chatPreviewAvatar}
                      style={{
                        width: `${Math.max(4, scaledFontSize)}px`,
                        height: `${Math.max(4, scaledFontSize)}px`,
                        backgroundColor: message.color,
                      }}
                      aria-hidden
                    />
                  )}
                  {showBadges && message.badge && (
                    <span
                      className={styles.chatBadge}
                      style={{
                        fontSize: `${Math.max(3, 9 * scale)}px`,
                        padding: `${Math.max(1, 2 * scale)}px ${Math.max(2, 4 * scale)}px`,
                        marginRight: `${Math.max(2, 4 * scale)}px`,
                        borderRadius: `${Math.max(1, 2 * scale)}px`,
                        lineHeight: 1,
                        display: "inline-block",
                        verticalAlign: "middle",
                      }}
                    >
                      {message.badge}
                    </span>
                  )}
                  <span
                    className={styles.chatPreviewUser}
                    style={{
                      color: message.color,
                      fontFamily,
                      fontSize: `${scaledFontSize}px`,
                      fontWeight: usernameFontWeight,
                      fontStyle,
                      textShadow: outlineShadow,
                      display: "inline",
                    }}
                  >
                    {message.user}:
                  </span>{" "}
                  <span className={styles.chatPreviewText} style={messageStyle}>
                    {message.fragments
                      ? toRenderParts(message.fragments).map((part, i) =>
                          part.kind === "emote" && showEmotes ? (
                            <span key={i} className={styles.chatPreviewEmoteStack}>
                              <img
                                src={part.fragment.url ?? ""}
                                alt={part.fragment.text ?? ""}
                                title={part.fragment.text ?? ""}
                                // Sized against the font so the preview keeps
                                // matching what the renderer will output.
                                style={{ height: `${scaledFontSize * 1.4}px` }}
                                loading="lazy"
                              />
                              {part.overlays.map((overlay, k) => (
                                <img
                                  key={k}
                                  className={styles.chatPreviewEmoteOverlay}
                                  src={overlay.url ?? ""}
                                  alt=""
                                  style={{ height: `${scaledFontSize * 1.4}px` }}
                                  loading="lazy"
                                />
                              ))}
                            </span>
                          ) : (
                            <span key={i}>
                              {part.kind === "emote" ? part.fragment.text : part.text}
                            </span>
                          ),
                        )
                      : message.text}
                  </span>
                  {showEmotes && !message.fragments && message.emote && (
                    <span
                      className={styles.chatPreviewEmote}
                      style={{
                        fontSize: `${Math.max(3, 9 * scale)}px`,
                        padding: `${Math.max(1, 2 * scale)}px ${Math.max(2, 4 * scale)}px`,
                        marginLeft: `${Math.max(2, 4 * scale)}px`,
                        borderRadius: `${Math.max(1, 2 * scale)}px`,
                        lineHeight: 1,
                        display: "inline-block",
                        verticalAlign: "middle",
                      }}
                    >
                      {message.emote}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {HANDLE_CONFIG.map((handle) => {
            const hSize = Math.max(6, Math.min(12, 12 * scale));
            const hOffset = -Math.round(hSize / 2);
            const handleStyle: React.CSSProperties = {
              width: `${hSize}px`,
              height: `${hSize}px`,
            };

            if (handle.id === "n") {
              handleStyle.top = `${hOffset}px`;
              handleStyle.height = `${Math.max(4, hSize / 2)}px`;
            } else if (handle.id === "s") {
              handleStyle.bottom = `${hOffset}px`;
              handleStyle.height = `${Math.max(4, hSize / 2)}px`;
            } else if (handle.id === "e") {
              handleStyle.right = `${hOffset}px`;
              handleStyle.width = `${Math.max(4, hSize / 2)}px`;
            } else if (handle.id === "w") {
              handleStyle.left = `${hOffset}px`;
              handleStyle.width = `${Math.max(4, hSize / 2)}px`;
            } else {
              if (handle.id.includes("n")) handleStyle.top = `${hOffset}px`;
              if (handle.id.includes("s")) handleStyle.bottom = `${hOffset}px`;
              if (handle.id.includes("e")) handleStyle.right = `${hOffset}px`;
              if (handle.id.includes("w")) handleStyle.left = `${hOffset}px`;
            }

            return (
              <button
                key={handle.id}
                type="button"
                aria-label={handle.label}
                className={`${styles.resizeHandle} ${handle.className}`}
                onPointerDown={(event) => startResize(event, handle.id)}
                onKeyDown={(event) => onHandleKeyDown(event, handle.id)}
                style={handleStyle}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function resizePlacement(
  start: ChatPlacement,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  lockRatio: boolean,
): ChatPlacement {
  const leftLocked = start.x + start.width;
  const topLocked = start.y + start.height;
  let x = start.x;
  let y = start.y;
  let width = start.width;
  let height = start.height;

  if (handle.includes("e")) width = start.width + dx;
  if (handle.includes("s")) height = start.height + dy;
  if (handle.includes("w")) {
    x = start.x + dx;
    width = start.width - dx;
  }
  if (handle.includes("n")) {
    y = start.y + dy;
    height = start.height - dy;
  }

  width = Math.max(MIN_CHAT_WIDTH, width);
  height = Math.max(MIN_CHAT_HEIGHT, height);

  if (lockRatio) {
    const ratio = start.width / Math.max(1, start.height);
    const horizontal = handle.includes("e") || handle.includes("w");
    const vertical = handle.includes("n") || handle.includes("s");
    const preferWidth = horizontal && (!vertical || Math.abs(dx) >= Math.abs(dy));

    if (preferWidth) {
      height = Math.max(MIN_CHAT_HEIGHT, Math.round(width / ratio));
    } else {
      width = Math.max(MIN_CHAT_WIDTH, Math.round(height * ratio));
    }
  }

  if (handle.includes("w")) x = leftLocked - width;
  if (handle.includes("n")) y = topLocked - height;

  return { ...start, x, y, width, height };
}

/** Shared placement normalization — single source of truth for page, preview and fields. */
export function normalizeChatPlacement(placement: ChatPlacement, constrainToBounds = true): ChatPlacement {
  let width = Math.min(placement.outputWidth, Math.max(MIN_CHAT_WIDTH, Math.round(placement.width)));
  let height = Math.min(placement.outputHeight, Math.max(MIN_CHAT_HEIGHT, Math.round(placement.height)));
  let x = Math.round(placement.x);
  let y = Math.round(placement.y);

  if (constrainToBounds) {
    x = clamp(x, 0, placement.outputWidth - width);
    y = clamp(y, 0, placement.outputHeight - height);
  }

  if (x < 0 && constrainToBounds) x = 0;
  if (y < 0 && constrainToBounds) y = 0;
  if (x + width > placement.outputWidth && constrainToBounds) width = placement.outputWidth - x;
  if (y + height > placement.outputHeight && constrainToBounds) height = placement.outputHeight - y;

  return { ...placement, x, y, width, height };
}

function alignmentGuides(placement: ChatPlacement) {
  return {
    vertical: Math.abs(placement.x + placement.width / 2 - placement.outputWidth / 2) <= 1,
    horizontal: Math.abs(placement.y + placement.height / 2 - placement.outputHeight / 2) <= 1,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
