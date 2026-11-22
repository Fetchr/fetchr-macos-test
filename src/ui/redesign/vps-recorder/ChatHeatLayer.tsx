import { memo, useMemo } from "react";

import { heatBars, type ChatHeat } from "./chatHeat";
import styles from "./RecordingTimeline.module.css";

const BARS = 120;

/**
 * Chat density behind the timeline: where chat exploded is usually the moment
 * worth clipping. Memoised on the visible window, so playback ticks skip it.
 */
export const ChatHeatLayer = memo(function ChatHeatLayer({
  heat,
  start,
  end,
}: {
  heat: ChatHeat;
  start: number;
  end: number;
}) {
  const bars = useMemo(() => heatBars(heat, start, end, BARS), [heat, start, end]);
  return (
    <div className={styles.chatHeat} aria-hidden="true">
      {bars.map((value, index) =>
        value > 0.02 ? (
          <i
            key={index}
            className={styles.chatHeatBar}
            style={{ left: `${(index / BARS) * 100}%`, width: `${100 / BARS}%`, height: `${Math.round(value * 100)}%` }}
          />
        ) : null,
      )}
    </div>
  );
});
