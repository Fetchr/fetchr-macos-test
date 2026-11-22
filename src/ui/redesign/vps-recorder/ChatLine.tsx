import type { VpsChatMessage } from "@/lib/ipc";

import { toRenderParts } from "@/lib/chatFragments";
import { fmtDuration } from "./format";
import styles from "./VpsRecorderPage.module.css";

/** One chat message, shared by the recorded and the live panels so they cannot
 *  drift apart visually. `onSeek` is absent for live chat — there is nothing to
 *  seek to yet. */
export function ChatLine({
  message,
  onSeek,
}: {
  message: VpsChatMessage;
  onSeek?: (seconds: number) => void;
}) {
  return (
    <div className={styles.chatLine}>
      {onSeek && (
        <button
          type="button"
          className={styles.chatTime}
          title="Перемотать сюда"
          onClick={() => onSeek(message.timestamp)}
        >
          {fmtDuration(message.timestamp)}
        </button>
      )}
      {(message.badges ?? [])
        .filter((badge) => badge.url)
        .map((badge) => (
          <img
            key={badge.id}
            className={styles.chatBadge}
            src={badge.url ?? ""}
            alt={badge.title ?? badge.id}
            title={badge.title ?? badge.id}
          />
        ))}
      <span className={styles.chatAuthor} style={{ color: message.user_color || undefined }}>
        {message.display_name || message.username}
      </span>
      <span className={styles.chatText}>
        {toRenderParts(message.fragments).map((part, i) =>
          part.kind === "emote" ? (
            <span className={styles.chatEmoteStack} key={i}>
              <img
                className={styles.chatEmote}
                src={part.fragment.url ?? ""}
                alt={part.fragment.text ?? ""}
                title={[part.fragment.text, ...part.overlays.map((o) => o.text)]
                  .filter(Boolean)
                  .join(" ")}
                loading="lazy"
              />
              {part.overlays.map((overlay, k) => (
                <img
                  key={k}
                  className={styles.chatEmoteOverlay}
                  src={overlay.url ?? ""}
                  alt=""
                  loading="lazy"
                />
              ))}
            </span>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
      </span>
    </div>
  );
}
