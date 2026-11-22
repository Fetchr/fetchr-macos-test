import styles from "./ChatRenderPage.module.css";

export type ChatPlatform = "twitch" | "kick" | "wtv";

export const CHAT_PLATFORMS: ReadonlyArray<{ id: ChatPlatform; label: string }> = [
  { id: "twitch", label: "Twitch" },
  { id: "kick", label: "Kick" },
  { id: "wtv", label: "W.TV" },
];

export const CHAT_SOURCE_PLACEHOLDER: Record<ChatPlatform, string> = {
  twitch: "https://www.twitch.tv/videos/...",
  kick: "https://kick.com/channel/videos/...",
  wtv: "JSON чата, записанный с эфира w.tv",
};

interface ChatPlatformSelectorProps {
  value: ChatPlatform;
  onChange: (value: ChatPlatform) => void;
}

export function ChatPlatformSelector({ value, onChange }: ChatPlatformSelectorProps) {
  return (
    <div className={styles.segmented} role="tablist" aria-label="Платформа чата">
      {CHAT_PLATFORMS.map((platform) => (
        <button
          className={`${styles.segment} ${value === platform.id ? styles.segmentActive : ""}`}
          key={platform.id}
          type="button"
          onClick={() => onChange(platform.id)}
        >
          {platform.label}
        </button>
      ))}
    </div>
  );
}
