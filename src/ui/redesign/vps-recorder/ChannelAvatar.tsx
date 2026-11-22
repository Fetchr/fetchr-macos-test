import { useState } from "react";

import { cn } from "@/lib/utils";

import { PlatformIcon } from "@/ui/redesign/icons/iconMap";

import { useChannelAvatar } from "./channelAvatars";
import { channelHue, channelParts } from "./format";
import styles from "./Shelf.module.css";

/** The channel's profile picture; until it loads (or if there is none) an
 *  initial on a colour picked from the channel name. */
export function ChannelAvatar({ channel, large }: { channel: string; large?: boolean }) {
  const url = useChannelAvatar(channel);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const hue = channelHue(channel);
  if (url && url !== failedUrl) {
    return (
      <img
        className={cn(styles.avatar, styles.avatarImage, large && styles.avatarLarge)}
        src={url}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setFailedUrl(url)}
      />
    );
  }
  return (
    <span
      className={cn(styles.avatar, large && styles.avatarLarge)}
      style={{ background: `hsl(${hue} 42% 30%)`, color: `hsl(${hue} 80% 86%)` }}
      aria-hidden="true"
    >
      {channelParts(channel).name.charAt(0).toUpperCase()}
    </span>
  );
}

/** Channel name with its platform's icon when it is not Twitch. */
export function ChannelName({ channel }: { channel: string }) {
  const { platform, name } = channelParts(channel);
  return (
    <span style={{ display: "inline-flex", minWidth: 0, alignItems: "center", gap: 4 }} title={name}>
      {platform !== "twitch" && <PlatformIcon platform={platform} className="size-3.5" />}
      {name}
    </span>
  );
}
