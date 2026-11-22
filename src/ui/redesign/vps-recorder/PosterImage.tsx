import { useEffect, useState } from "react";

import { useVpsRecorderStore } from "@/stores/vpsRecorder";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./VpsRecorderPage.module.css";

interface PosterImageProps {
  kind: "recording" | "clip";
  id: string;
  /** Position of the frame to pull, in session seconds. Ignored for clips. */
  at?: number;
  alt: string;
}

/**
 * Thumbnail served by the agent (a single re-encoded frame, cached there).
 * A recording with no closed segment yet simply has no frame — that is an empty
 * tile, not an error worth a toast.
 */
export function PosterImage({ kind, id, at = 0, alt }: PosterImageProps) {
  const posterFor = useVpsRecorderStore((s) => s.posterFor);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setUrl(null);
    void posterFor(kind, id, at).then((value) => {
      if (!cancelled) setUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [kind, id, at, posterFor]);

  if (!url || failed) {
    return <RedesignIcon name="video" className={styles.posterEmpty} />;
  }
  return (
    <img
      className={styles.posterImage}
      src={url}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
