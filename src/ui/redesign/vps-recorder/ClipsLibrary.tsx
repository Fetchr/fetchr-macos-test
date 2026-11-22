import { useCallback, useMemo, useRef, useState } from "react";

import { ipc, type VpsClipMeta } from "@/lib/ipc";
import { notifyError } from "@/lib/notify";
import { useSettings } from "@/stores/settings";
import { useVpsRecorderStore } from "@/stores/vpsRecorder";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { ClipDemo, DemoSlot } from "@/ui/redesign/demos/DemoSlot";
import { cn } from "@/lib/utils";

import { ChannelAvatar } from "./ChannelAvatar";
import { ClipViewer } from "./ClipViewer";
import { fmtBytes, fmtCount, fmtDuration, fmtShortDate } from "./format";
import { NeedDownloadFolder } from "./NeedDownloadFolder";
import { PosterImage } from "./PosterImage";
import shelf from "./Shelf.module.css";
import styles from "./VpsRecorderPage.module.css";

function clipTitle(clip: VpsClipMeta): string {
  return (clip.label ?? "").trim() || `${clip.channel ?? "клип"} · ${fmtDuration(clip.duration)}`;
}

export function ClipsLibrary({
  clips,
  emptyText = "Клипов пока нет",
  showFilter = false,
  onOpen,
}: {
  clips: VpsClipMeta[];
  emptyText?: string;
  showFilter?: boolean;
  /** Replaces the built-in viewer, for pages that already have a player. */
  onOpen?: (clip: VpsClipMeta) => void;
}) {
  const busy = useVpsRecorderStore((s) => s.busy);
  const downloadClip = useVpsRecorderStore((s) => s.downloadClip);
  const scheduleDelete = useVpsRecorderStore((s) => s.scheduleDelete);
  const setClipKeep = useVpsRecorderStore((s) => s.setClipKeep);

  const directory = useSettings((state) => state.directory);
  const maxConcurrentJobs = useSettings((state) => state.maxConcurrentJobs);
  const chatOverlay = useSettings((state) => state.chatOverlay);
  const performance = useSettings((state) => state.performance);
  const blurZones = useSettings((state) => state.blurZones);

  const [query, setQuery] = useState("");
  const [embedChat, setEmbedChat] = useState(true);
  const [applyMute, setApplyMute] = useState(false);
  const [applyBlur, setApplyBlur] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // A pending preview request; a quicker click on the next clip must win.
  const openSeq = useRef(0);

  // Hidden at once; the server deletes it after the «Отменить» window.
  const deleteClip = (clip: VpsClipMeta) => scheduleDelete([{ kind: "clip", id: clip.id, title: clipTitle(clip) }]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return clips;
    return clips.filter((clip) =>
      [clip.label, clip.note, clip.channel, ...(clip.tags ?? [])]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [clips, query]);

  const openClip = useCallback(
    async (clip: VpsClipMeta) => {
      if (onOpen) {
        onOpen(clip);
        return;
      }
      const seq = ++openSeq.current;
      setOpenId(clip.id);
      setPreviewUrl(null);
      try {
        const url = await ipc.vpsClipPreviewUrl(clip.id);
        if (seq === openSeq.current) setPreviewUrl(url);
      } catch (error) {
        if (seq !== openSeq.current) return;
        setOpenId(null);
        notifyError("Не удалось открыть клип", error);
      }
    },
    [onOpen],
  );
  const closeClip = useCallback(() => {
    openSeq.current += 1;
    setOpenId(null);
    setPreviewUrl(null);
  }, []);

  const openIndex = openId ? visible.findIndex((clip) => clip.id === openId) : -1;
  const opened = openIndex >= 0 ? visible[openIndex] : null;

  const download = (clip: VpsClipMeta) =>
    downloadClip(clip, directory, maxConcurrentJobs, {
      chatOverlay: embedChat && clip.chat_messages > 0 ? { ...chatOverlay, enabled: true } : null,
      performance,
      blurZones: applyBlur ? blurZones : [],
      fetchrMuteEnabled: applyMute,
    });

  if (clips.length === 0) {
    return (
      <div className={shelf.empty}>
        <DemoSlot demo={ClipDemo} height={268} />
        <h3 className={shelf.emptyTitle}>{emptyText}</h3>
        <p className={shelf.emptyText}>
          Откройте запись, выделите отрезок клавишами I и O и нажмите «Создать клип»: клип
          соберётся на сервере, а на компьютер придёт уже готовый файл.
        </p>
      </div>
    );
  }

  return (
    <>
      {showFilter && (
        <div className={styles.filterRow}>
          <input
            className={styles.input}
            style={{ maxWidth: 280 }}
            placeholder="Поиск по названию, тегу, каналу"
            aria-label="Поиск клипов"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className={styles.checkbox} title="При скачивании наложить чат эфира на видео">
            <input
              type="checkbox"
              checked={embedChat}
              onChange={(event) => setEmbedChat(event.target.checked)}
            />
            Встроить чат
          </label>
          <label className={styles.checkbox} title="При скачивании убрать маты из звука">
            <input
              type="checkbox"
              checked={applyMute}
              onChange={(event) => setApplyMute(event.target.checked)}
            />
            Fetchr Mute
          </label>
          <label
            className={styles.checkbox}
            title={blurZones.length ? undefined : "Сначала создайте зоны Sponsor Blur"}
          >
            <input
              type="checkbox"
              checked={applyBlur}
              disabled={blurZones.length === 0}
              onChange={(event) => setApplyBlur(event.target.checked)}
            />
            Sponsor Blur
          </label>
        </div>
      )}

      {opened && (
        <ClipViewer
          clip={opened}
          title={clipTitle(opened)}
          src={previewUrl}
          position={openIndex + 1}
          total={visible.length}
          downloading={Boolean(busy[`dl_${opened.id}`])}
          canDownload={Boolean(directory)}
          keepBusy={Boolean(busy[`keep_${opened.id}`])}
          onDownload={() => void download(opened)}
          onKeep={() => void setClipKeep(opened.id, !opened.keep)}
          onDelete={() => {
            closeClip();
            deleteClip(opened);
          }}
          onPrev={openIndex > 0 ? () => void openClip(visible[openIndex - 1]) : null}
          onNext={
            openIndex < visible.length - 1 ? () => void openClip(visible[openIndex + 1]) : null
          }
          onClose={closeClip}
        />
      )}

      {/* Inside a recording the same notice already sits under its header. */}
      {!directory && showFilter && <NeedDownloadFolder />}

      {visible.length === 0 && (
        <p className={styles.panelHelp} role="status">
          По запросу «{query.trim()}» клипов нет.{" "}
          <button type="button" className={styles.ghostButton} onClick={() => setQuery("")}>
            Сбросить поиск
          </button>
        </p>
      )}

      <div className={shelf.grid}>
        {visible.map((clip) => {
          const downloading = busy[`dl_${clip.id}`];
          return (
            <article className={cn(shelf.card, clip.id === openId && shelf.cardActive)} key={clip.id}>
              <button
                type="button"
                className={shelf.cardOpen}
                onClick={() => void openClip(clip)}
                title={clipTitle(clip)}
                aria-current={clip.id === openId ? "true" : undefined}
              >
                <span className={shelf.poster}>
                  <PosterImage kind="clip" id={clip.id} alt={clipTitle(clip)} />
                  <span className={shelf.scrim} aria-hidden="true" />
                  <span className={shelf.duration}>{fmtDuration(clip.duration)}</span>
                  {clip.keep && (
                    <span className={shelf.badgeKeep}>
                      <RedesignIcon name="bookmark" />
                      Закреплён
                    </span>
                  )}
                </span>
                <span className={shelf.cardBody}>
                  <span className={shelf.cardTitle}>{clipTitle(clip)}</span>
                  <span className={shelf.channel}>
                    {clip.channel && <ChannelAvatar channel={clip.channel} />}
                    <span className={shelf.channelName}>{clip.channel ?? "—"}</span>
                    <span className={shelf.dot} aria-hidden="true" />
                    <span className={shelf.when}>
                      {fmtShortDate(clip.absolute_start_at ?? clip.created_at)}
                    </span>
                  </span>
                  <span className={shelf.stats}>
                    <span>
                      <RedesignIcon name="video" />
                      {fmtBytes(clip.video_size)}
                    </span>
                    {clip.chat_messages > 0 && (
                      <span>
                        <RedesignIcon name="chat" />
                        {fmtCount(clip.chat_messages)}
                      </span>
                    )}
                  </span>
                  {clip.note && <span className={shelf.note}>{clip.note}</span>}
                  {clip.tags && clip.tags.length > 0 && (
                    <span className={shelf.tags}>
                      {clip.tags.map((tag) => (
                        <span key={tag} className={shelf.tag}>
                          #{tag}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
              <div className={shelf.cardActions}>
                <button
                  type="button"
                  className={cn(shelf.iconButton, shelf.iconButtonPrimary)}
                  disabled={downloading || !directory}
                  title={directory ? "Скачать и обработать" : "Сначала укажите папку в настройках"}
                  onClick={() => void download(clip)}
                >
                  <RedesignIcon
                    name={downloading ? "loading" : "download"}
                    className={downloading ? shelf.spinning : undefined}
                  />
                  Скачать
                </button>
                <button
                  type="button"
                  className={cn(shelf.iconButton, clip.keep && shelf.iconButtonActive)}
                  disabled={busy[`keep_${clip.id}`]}
                  aria-pressed={Boolean(clip.keep)}
                  aria-label={clip.keep ? "Снять защиту от автоочистки" : "Не удалять при нехватке места"}
                  title={clip.keep ? "Снять защиту от автоочистки" : "Не удалять при нехватке места"}
                  onClick={() => void setClipKeep(clip.id, !clip.keep)}
                >
                  <RedesignIcon name="bookmark" />
                </button>
                <button
                  type="button"
                  className={shelf.iconButton}
                  aria-label={`Удалить клип «${clipTitle(clip)}» с сервера`}
                  title="Удалить клип с сервера (5 секунд можно отменить)"
                  onClick={() => deleteClip(clip)}
                >
                  <RedesignIcon name="trash" />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
