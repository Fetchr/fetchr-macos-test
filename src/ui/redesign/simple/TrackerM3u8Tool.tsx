import { useEffect, useRef, useState, type FormEvent } from "react";

import { cn } from "@/lib/utils";
import type { TrackerDiscoveryMeta } from "@/services/m3u8/m3u8DiscoveryTypes";
import { recoverM3u8FromTrackerMeta } from "@/services/m3u8/m3u8RecoveryService";
import type { SearchHint } from "@/services/streams/streamSearch";
import { discoverTrackerMetadata } from "@/services/m3u8/trackerDiscoveryService";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./DownloadOverlay.module.css";

type State =
  | { phase: "idle" }
  | { phase: "working"; step: string }
  | { phase: "done"; urls: string[]; tried: number; meta: TrackerDiscoveryMeta }
  | { phase: "error"; message: string };

/**
 * m3u8 по ссылке TwitchTracker: восстанавливает адрес плейлиста записи, даже
 * удалённой. Найденную ссылку можно скопировать или сразу открыть в поиске.
 */
export function TrackerM3u8Tool({ onOpen }: { onOpen: (url: string, hint: SearchHint) => void }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("");
  const [state, setState] = useState<State>({ phase: "idle" });
  const [copied, setCopied] = useState<string | null>(null);
  const runRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const generate = async (event: FormEvent) => {
    event.preventDefault();
    const sourceUrl = link.trim();
    if (!sourceUrl) return;
    const run = ++runRef.current;
    try {
      setState({ phase: "working", step: "Читаю TwitchTracker…" });
      const meta = await discoverTrackerMetadata({ sourceUrl });
      if (run !== runRef.current) return;
      setState({ phase: "working", step: "Подбираю ссылку на плейлист…" });
      const result = await recoverM3u8FromTrackerMeta(meta);
      if (run !== runRef.current) return;
      const urls = result.urls.map((item) => item.url);
      setState(
        urls.length > 0
          ? { phase: "done", urls, tried: result.tried, meta }
          : { phase: "error", message: `Плейлист не найден (проверено вариантов: ${result.tried}).` },
      );
    } catch (reason) {
      if (run !== runRef.current) return;
      setState({ phase: "error", message: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  const copy = (url: string) => {
    void navigator.clipboard.writeText(url).then(() => setCopied(url));
  };

  return (
    <div className={styles.trackerTool}>
      {open && (
        <div className={styles.trackerPanel} role="group" aria-label="m3u8 по ссылке TwitchTracker">
          <form className={styles.trackerForm} onSubmit={(event) => void generate(event)}>
            <input
              ref={inputRef}
              className={styles.trackerInput}
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="twitchtracker.com/ник/streams/id"
              aria-label="Ссылка TwitchTracker"
              spellCheck={false}
            />
            <button type="submit" className={styles.trackerGo} disabled={!link.trim() || state.phase === "working"}>
              {state.phase === "working" ? <RedesignIcon name="loading" className={cn("size-3.5", styles.spin)} /> : "Найти m3u8"}
            </button>
          </form>

          {state.phase === "working" && <p className={styles.trackerNote}>{state.step}</p>}
          {state.phase === "error" && (
            <p className={styles.trackerError} role="alert">
              {state.message}
            </p>
          )}
          {state.phase === "done" && (
            <ul className={styles.trackerList}>
              {state.urls.map((url) => (
                <li key={url}>
                  <code title={url}>{url}</code>
                  <button type="button" onClick={() => copy(url)} title="Скопировать ссылку" aria-label="Скопировать ссылку">
                    <RedesignIcon name={copied === url ? "check" : "copy"} className="size-3.5" />
                  </button>
                  <button type="button" onClick={() =>
                      onOpen(url, {
                        url,
                        title: state.meta.title,
                        username: state.meta.username,
                        thumbnailUrl: state.meta.thumbnailUrl,
                      })
                    } title="Открыть для скачивания" aria-label="Открыть для скачивания">
                    <RedesignIcon name="download" className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <button type="button" className={styles.trackerToggle} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <RedesignIcon name="link" className="size-3" />
        m3u8 по TwitchTracker
      </button>
    </div>
  );
}
