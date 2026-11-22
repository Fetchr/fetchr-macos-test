import { useEffect, useMemo, useRef } from "react";

import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { ChatLine } from "./ChatLine";
import { fmtDuration } from "./format";
import { useRecordingChat } from "./recordingChatCache";
import styles from "./VpsRecorderPage.module.css";

/** Lines kept on screen. Rendering a whole broadcast's chat would stall the UI
 *  and nobody scrolls back thousands of messages anyway. */
const WINDOW = 150;

/**
 * Chat as it was during the recording, following playback — the context that
 * tells you *why* a moment mattered, which the video alone often does not.
 *
 * Messages carry timecodes on the session timeline, so this is a filter over a
 * loaded array rather than a live feed.
 */
export function RecordingChat({
  session,
  channel,
  live = false,
  playhead,
  onSeek,
}: {
  session: string;
  channel: string | null;
  /** Still recording: the cached chat is refreshed rather than kept. */
  live?: boolean;
  playhead: number;
  onSeek: (seconds: number) => void;
}) {
  // Cached per recording and shared with the timeline heatmap.
  const { messages, error, retry } = useRecordingChat(session, channel, { live });
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const { visible, offset } = useMemo(() => {
    if (!messages) return { visible: [], offset: 0 };
    // Binary search: a 27-hour chat is tens of thousands of lines and this runs
    // on every timeupdate.
    let low = 0;
    let high = messages.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (messages[mid].timestamp <= playhead) low = mid + 1;
      else high = mid;
    }
    const from = Math.max(0, low - WINDOW);
    return { visible: messages.slice(from, low), offset: from };
  }, [messages, playhead]);

  /** Emotes that came from BTTV/FFZ/7TV rather than Twitch itself. Shown in the
   *  header so a failed emote load is visible instead of just looking plain. */
  const thirdPartyEmotes = useMemo(() => {
    if (!messages) return null;
    let count = 0;
    for (const message of messages) {
      for (const fragment of message.fragments) {
        if (
          fragment.type === "emote" &&
          fragment.provider &&
          fragment.provider !== "twitch"
        ) {
          count += 1;
        }
      }
    }
    return count;
  }, [messages]);

  // Scroll the chat box itself. `scrollIntoView` walks up to every scrollable
  // ancestor, so each new message would also yank the whole page.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !pinnedRef.current) return;
    body.scrollTop = body.scrollHeight;
  }, [visible.length, visible[visible.length - 1]?.timestamp]);

  return (
    // The panel is taken out of flow inside this slot: as a normal grid child
    // its full message list defined the row height, so it grew instead of
    // scrolling.
    <div className={styles.chatSlot}>
      <div className={styles.chatPanel}>
        <div className={styles.chatHeader}>
          <RedesignIcon name="chat" />
          <span>
            {messages
              ? `${messages.length.toLocaleString("ru-RU")} сообщений, идут вместе с видео`
              : "Чат записи"}
          </span>
          <span className={styles.barSpacer} />
          {thirdPartyEmotes != null && (
            <span
              className={styles.tabCount}
              title={
                thirdPartyEmotes > 0
                  ? "Эмоутов BTTV/FFZ/7TV подставлено"
                  : "Эмоуты BTTV/FFZ/7TV не подставились — подробности в Логах"
              }
            >
              {thirdPartyEmotes > 0 ? `+${thirdPartyEmotes}` : "—"}
            </span>
          )}
        </div>
        <div
          className={styles.chatBody}
          ref={bodyRef}
          onScroll={(event) => {
            // Scrolling up to read something older must not be undone by the
            // next message arriving.
            const el = event.currentTarget;
            pinnedRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {error && (
            <div className={styles.chatWaiting} role="alert">
              <p>Чат не загрузился. {error}</p>
              <button type="button" className={styles.chatJump} onClick={retry}>
                Повторить
              </button>
            </div>
          )}
          {!messages && !error && (
            <div
              className={styles.chatSkeleton}
              aria-label="Загрузка чата"
              role="status"
            >
              {[72, 48, 88, 60, 80, 40, 66, 92, 54, 70].map((width, index) => (
                <span key={index} style={{ width: `${width}%` }} />
              ))}
            </div>
          )}
          {messages && messages.length === 0 && (
            <p className={styles.panelHelp}>Чат для этой записи не сохранён.</p>
          )}
          {messages && messages.length > 0 && visible.length === 0 && (
            <div className={styles.chatWaiting}>
              <p>Сообщения появятся, когда воспроизведение дойдёт до них.</p>
              <button
                type="button"
                className={styles.chatJump}
                onClick={() => onSeek(messages[0].timestamp)}
              >
                К первому сообщению · {fmtDuration(messages[0].timestamp)}
              </button>
            </div>
          )}
          {/* Keyed by position in the whole chat: a key relative to the window
              shifted on every new line and remounted all of them. */}
          {visible.map((message, index) => (
            <ChatLine
              key={offset + index}
              message={message}
              onSeek={onSeek}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
