import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";

import { HlsPlayer, type HlsPlayerHandle } from "@/components/hls-player";
import type { VpsRecordingMeta } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";
import { useVpsRecorderStore } from "@/stores/vpsRecorder";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { ArchiveMenu, type MenuAnchor } from "./ArchiveMenu";
import { recordingTitle } from "./archiveModel";
import { ChannelAvatar, ChannelName } from "./ChannelAvatar";
import { buildChatHeat } from "./chatHeat";
import { ClipEditor } from "./ClipEditor";
import { ClipsLibrary } from "./ClipsLibrary";
import { channelParts, fmtBytes, fmtDuration, fmtShortDate, parseTimecode } from "./format";
import { LiveChat } from "./LiveChat";
import { HotkeysInfo, MarkerList, RecordingFacts } from "./MarkerList";
import { NeedDownloadFolder } from "./NeedDownloadFolder";
import { playerToSession } from "./playerTimeline";
import { RecordingChat } from "./RecordingChat";
import { useRecordingChat } from "./recordingChatCache";
import detail from "./RecordingDetail.module.css";
import { RecordingTimeline, type RangePreset } from "./RecordingTimeline";
import { useVisibleClips } from "./usePendingDeletes";
import { useClipHotkeys, usePreview, useThrottledSeek, type PreviewState } from "./useRecordingPlayer";

const EMPTY_RANGE = { start: "", end: "" };

/** Перемотка, запрошенная снаружи (выбор метки или клипа в поиске). */
export interface SeekRequest {
  session: string;
  at: number;
  /** Новый запрос к тому же моменту тоже перематывает. */
  nonce: number;
}

type SideTab = "chat" | "markers";

function useClipRange(session: string) {
  // No range until the user marks one: a default of "the whole recording" both
  // invited a multi-hour clip and went stale while a live session kept growing.
  // Kept in the store per session, so leaving the page does not drop it.
  const range = useVpsRecorderStore((s) => s.clipRanges[session]) ?? EMPTY_RANGE;
  const setClipRange = useVpsRecorderStore((s) => s.setClipRange);
  const setRangeStart = useCallback((value: string) => setClipRange(session, { start: value }), [setClipRange, session]);
  const setRangeEnd = useCallback((value: string) => setClipRange(session, { end: value }), [setClipRange, session]);
  const selection = useMemo(() => {
    const start = parseTimecode(range.start);
    const end = parseTimecode(range.end);
    return start != null && end != null && end > start ? { start, end } : null;
  }, [range.start, range.end]);
  return { rangeStart: range.start, rangeEnd: range.end, setRangeStart, setRangeEnd, selection };
}

function useChatSide(recording: VpsRecordingMeta, live: boolean) {
  // A fresh live session has no saved messages yet but still gets a chat
  // column — the relay does not depend on what the server has stored.
  // The live IRC relay is Twitch-only; Kick/W.TV chat shows from the recorded file.
  const showsLiveChat =
    live && Boolean(recording.channel) && channelParts(recording.channel ?? "").platform === "twitch";
  const hasChat = recording.chat_messages > 0 || showsLiveChat;
  // Same cached request as the chat panel: the heatmap costs no extra load.
  const chatStored = recording.chat_messages > 0 && !showsLiveChat;
  const { messages } = useRecordingChat(recording.session, recording.channel, { enabled: chatStored, live });
  const position = recording.duration;
  // A live session grows every poll; a coarse span keeps this from rerunning each time.
  const heatSpan = live ? Math.ceil(Math.max(position, 1) / 600) * 600 : Math.max(position, 1);
  const heat = useMemo(
    () => (chatStored && messages ? buildChatHeat(messages, heatSpan) : null),
    [chatStored, messages, heatSpan],
  );
  const [sideTab, setSideTab] = useState<SideTab>(hasChat ? "chat" : "markers");
  // Chat that shows up later (first messages, stream goes live) takes the side
  // panel — unless the user already picked a tab by hand.
  const pickedByUser = useRef(false);
  useEffect(() => {
    if (hasChat && !pickedByUser.current) setSideTab("chat");
  }, [hasChat]);
  const pickSideTab = useCallback((tab: SideTab) => {
    pickedByUser.current = true;
    setSideTab(tab);
  }, []);
  return { showsLiveChat, hasChat, heat, showChat: hasChat && sideTab === "chat", pickSideTab };
}

function useMoreMenu() {
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; kind: "main" | "hotkeys" } | null>(null);
  // Нажатие на «…» при открытом меню сначала закрывает его снаружи; без отметки клик открыл бы его снова.
  const closedAt = useRef(0);
  const closeMenu = useCallback((restoreFocus: boolean) => {
    closedAt.current = Date.now();
    setMenu(null);
    if (restoreFocus) moreRef.current?.focus();
  }, []);
  const openMenu = useCallback((kind: "main" | "hotkeys") => {
    const rect = moreRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenu({ kind, anchor: { x: rect.right, y: rect.bottom + 4, above: rect.top - 4, align: "end" } });
  }, []);
  const toggle = () => {
    if (Date.now() - closedAt.current > 250) openMenu("main");
  };
  return { moreRef, menu, closeMenu, openMenu, toggle };
}

export function RecordingDetail({
  recording,
  scrollOnOpen = false,
  seekTo = null,
}: {
  recording: VpsRecordingMeta;
  /** Only an explicit pick scrolls; the auto-opened first recording must not jump the page. */
  scrollOnOpen?: boolean;
  seekTo?: SeekRequest | null;
}) {
  const playerRef = useRef<HlsPlayerHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sideId = useId();

  // Opening a recording lands on the player, not on the status strip above it.
  useEffect(() => {
    if (scrollOnOpen) rootRef.current?.scrollIntoView({ block: "start" });
  }, [recording.session, scrollOnOpen]);

  const clips = useVisibleClips(useVpsRecorderStore((s) => s.clips));
  const markerBusy = useVpsRecorderStore((s) => Boolean(s.busy.marker));
  const downloading = useVpsRecorderStore((s) => Boolean(s.busy[`dl_rec_${recording.session}`]));
  const saveMarker = useVpsRecorderStore((s) => s.saveMarker);
  const deleteMarker = useVpsRecorderStore((s) => s.deleteMarker);
  const downloadRecording = useVpsRecorderStore((s) => s.downloadRecording);
  const directory = useSettings((state) => state.directory);
  const maxConcurrentJobs = useSettings((state) => state.maxConcurrentJobs);

  const preview = usePreview(recording);
  const [playhead, setPlayhead] = useState(recording.available_start);
  const { rangeStart, rangeEnd, setRangeStart, setRangeEnd, selection } = useClipRange(recording.session);
  const position = recording.duration;
  const live = recording.status === "recording" || recording.status === "reconnecting";
  const side = useChatSide(recording, live);
  const [chatOpen, setChatOpen] = useState(false);
  const more = useMoreMenu();
  const sessionClips = useMemo(() => clips.filter((clip) => clip.session === recording.session), [clips, recording.session]);
  const { originRef } = preview;

  /** Player time mapped onto the session timeline. */
  const toSession = useCallback(
    (value: number) =>
      playerToSession(value, playerRef.current?.getFragments?.() ?? [], recording.started_at) ?? originRef.current + value,
    [recording.started_at, originRef],
  );
  const currentTime = useCallback(() => {
    const value = playerRef.current?.getCurrentTime();
    if (value == null || !Number.isFinite(value)) return playhead;
    return Math.min(position, toSession(value));
  }, [playhead, position, toSession]);
  const { seek, scrubbing } = useThrottledSeek(playerRef, originRef, recording.started_at, setPlayhead);

  const addMarker = useCallback(
    (session: string, seconds: number) => void saveMarker(session, seconds, "Метка", ""),
    [saveMarker],
  );
  useClipHotkeys({ session: recording.session, currentTime, onRangeStart: setRangeStart, onRangeEnd: setRangeEnd, onMarker: addMarker });

  const pendingJump = useSeekRequest(seekTo, seek, playerRef);

  const applyPreset = useCallback(
    (preset: RangePreset) => {
      if (preset === "all") {
        setRangeStart(fmtDuration(recording.available_start));
        setRangeEnd(fmtDuration(position));
        return;
      }
      const end = currentTime();
      const length = preset === "last30" ? 30 : 300;
      setRangeStart(fmtDuration(Math.max(recording.available_start, end - length)));
      setRangeEnd(fmtDuration(end));
    },
    [currentTime, position, recording.available_start, setRangeStart, setRangeEnd],
  );

  const download = () => void downloadRecording(recording, directory, maxConcurrentJobs);

  return (
    <div ref={rootRef} className={detail.detail} data-chat-open={chatOpen || undefined}>
      <DetailHeader
        recording={recording}
        live={live}
        downloading={downloading}
        hasDirectory={Boolean(directory)}
        onDownload={download}
        chatLabel={side.hasChat ? "Чат" : "Метки"}
        chatOpen={chatOpen}
        sideId={sideId}
        onToggleChat={() => setChatOpen((open) => !open)}
        moreRef={more.moreRef}
        menuOpen={more.menu != null}
        onMore={more.toggle}
      />

      <ArchiveMenu
        anchor={more.menu?.anchor ?? null}
        label={more.menu?.kind === "hotkeys" ? "Горячие клавиши" : "Подробности записи"}
        onClose={more.closeMenu}
        info={more.menu?.kind === "hotkeys" ? <HotkeysInfo /> : <RecordingFacts recording={recording} />}
        items={
          more.menu?.kind === "hotkeys"
            ? []
            : [
                {
                  id: "hotkeys",
                  label: "Горячие клавиши…",
                  icon: "info",
                  onSelect: () => window.setTimeout(() => more.openMenu("hotkeys"), 0),
                },
              ]
        }
      />

      {!directory && recording.available && <NeedDownloadFolder />}

      <div className={detail.layout}>
        <div className={detail.main}>
          <PlayerStage
            state={preview.previewState}
            url={preview.previewUrl}
            error={preview.previewError}
            playerRef={playerRef}
            onRetry={() => void preview.openPreview()}
            onTime={(value) => {
              // While a scrub is in flight the player still reports the old
              // position; letting it through would drag the marker backwards.
              if (!scrubbing()) setPlayhead(toSession(value));
            }}
            onLoaded={() => {
              const at = pendingJump.current;
              pendingJump.current = null;
              if (at != null) seek(at);
            }}
          />

          <RecordingTimeline
            recording={recording}
            position={position}
            playhead={playhead}
            selection={selection}
            heat={side.heat}
            onSeek={seek}
            onSelect={(start, end) => {
              setRangeStart(fmtDuration(start));
              setRangeEnd(fmtDuration(end));
            }}
            onPreset={applyPreset}
          />

          <ClipEditor
            recording={recording}
            position={position}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onRangeStart={setRangeStart}
            onRangeEnd={setRangeEnd}
            currentTime={currentTime}
          />
        </div>

        <SidePanel
          id={sideId}
          recording={recording}
          live={live}
          side={side}
          playhead={playhead}
          markerBusy={markerBusy}
          onClose={() => setChatOpen(false)}
          onSeek={seek}
          onAddMarker={(label) => void saveMarker(recording.session, currentTime(), label || "Метка", "")}
          onDeleteMarker={(id) => void deleteMarker(recording.session, id)}
          onRangeStart={(value) => setRangeStart(fmtDuration(value))}
          onRangeEnd={(value) => setRangeEnd(fmtDuration(value))}
        />
      </div>

      {/* Only once something exists: an empty-state box the size of the
          player pushed everything else off screen. */}
      {sessionClips.length > 0 && (
        <section className={detail.clips}>
          <h3 className={detail.sectionTitle}>
            Клипы этой записи <span className={detail.count}>{sessionClips.length}</span>
          </h3>
          <ClipsLibrary
            clips={sessionClips}
            onOpen={(clip) => {
              // The player is already on screen: jump to the clip and select
              // it instead of opening a second player.
              seek(clip.start);
              rootRef.current?.scrollIntoView({ block: "start" });
              setRangeStart(fmtDuration(clip.start));
              setRangeEnd(fmtDuration(clip.end));
            }}
          />
        </section>
      )}
    </div>
  );
}

/**
 * A jump asked for from search. The player of a just-opened recording is not
 * loaded yet, so the target waits for its first duration report.
 */
function useSeekRequest(
  request: SeekRequest | null,
  seek: (seconds: number) => void,
  playerRef: MutableRefObject<HlsPlayerHandle | null>,
) {
  const pending = useRef<number | null>(null);
  useEffect(() => {
    if (!request) return;
    const loaded = (playerRef.current?.getFragments?.().length ?? 0) > 0;
    seek(request.at);
    pending.current = loaded ? null : request.at;
  }, [request, seek, playerRef]);
  return pending;
}

function SidePanel({
  id,
  recording,
  live,
  side,
  playhead,
  markerBusy,
  onClose,
  onSeek,
  onAddMarker,
  onDeleteMarker,
  onRangeStart,
  onRangeEnd,
}: {
  id: string;
  recording: VpsRecordingMeta;
  live: boolean;
  side: ReturnType<typeof useChatSide>;
  playhead: number;
  markerBusy: boolean;
  onClose: () => void;
  onSeek: (seconds: number) => void;
  onAddMarker: (label: string) => void;
  onDeleteMarker: (id: string) => void;
  onRangeStart: (seconds: number) => void;
  onRangeEnd: (seconds: number) => void;
}) {
  return (
    <aside
      id={id}
      className={detail.side}
      aria-label="Чат и метки"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className={detail.sideTabs} role="tablist" aria-label="Боковая панель">
        {side.hasChat && (
          <SideTabButton active={side.showChat} icon="chat" label="Чат" onClick={() => side.pickSideTab("chat")}>
            {live && <span className={detail.liveDot} title="В прямом эфире" />}
          </SideTabButton>
        )}
        <SideTabButton active={!side.showChat} icon="bookmark" label="Метки" onClick={() => side.pickSideTab("markers")}>
          {recording.markers.length > 0 && <span className={detail.count}>{recording.markers.length}</span>}
        </SideTabButton>
        <button type="button" className={detail.sideClose} onClick={onClose} aria-label="Закрыть панель">
          <RedesignIcon name="close" />
        </button>
      </div>
      <div className={detail.sideBody} role="tabpanel" aria-label={side.showChat ? "Чат" : "Метки"}>
        {side.showChat ? (
          // A live session's chat.json is still growing on the server, so
          // relay Twitch directly while the stream is on air.
          side.showsLiveChat && recording.channel ? (
            <LiveChat channel={recording.channel} />
          ) : (
            <RecordingChat session={recording.session} channel={recording.channel} live={live} playhead={playhead} onSeek={onSeek} />
          )
        ) : (
          <MarkerList
            recording={recording}
            busy={markerBusy}
            onAdd={onAddMarker}
            onDelete={onDeleteMarker}
            onSeek={onSeek}
            onRangeStart={onRangeStart}
            onRangeEnd={onRangeEnd}
          />
        )}
      </div>
    </aside>
  );
}

function SideTabButton({
  active,
  icon,
  label,
  onClick,
  children,
}: {
  active: boolean;
  icon: "chat" | "bookmark";
  label: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn(detail.sideTab, active && detail.sideTabActive)}
      onClick={onClick}
    >
      <RedesignIcon name={icon} />
      {label}
      {children}
    </button>
  );
}

function DetailHeader(props: {
  recording: VpsRecordingMeta;
  live: boolean;
  downloading: boolean;
  hasDirectory: boolean;
  onDownload: () => void;
  chatLabel: string;
  chatOpen: boolean;
  sideId: string;
  onToggleChat: () => void;
  moreRef: MutableRefObject<HTMLButtonElement | null>;
  menuOpen: boolean;
  onMore: () => void;
}) {
  const { recording, live, downloading, hasDirectory } = props;
  const downloadHint = !recording.available
    ? "Видео уже удалено с сервера"
    : hasDirectory
      ? `Скачать всю запись · ${fmtBytes(recording.video_size)}`
      : "Сначала укажите папку в настройках";
  return (
    <header className={detail.header}>
      <div className={detail.heading}>
        <h2 className={detail.title}>
          {recording.channel && <ChannelAvatar channel={recording.channel} large />}
          <span className={detail.titleText} title={recordingTitle(recording)}>
            {recordingTitle(recording)}
          </span>
          {live && (
            <span className={cn(detail.liveChip, recording.status === "reconnecting" && detail.liveChipWarn)}>
              <span className={detail.recDot} aria-hidden="true" />
              {recording.status === "reconnecting" ? "Переподключение" : "Идёт запись"}
            </span>
          )}
        </h2>
        <p className={detail.meta}>
          {recording.channel && recording.title && (
            <span>
              <ChannelName channel={recording.channel} />
            </span>
          )}
          <span>{fmtShortDate(recording.started_at)}</span>
          <span>{fmtDuration(recording.duration)}</span>
        </p>
      </div>
      <button
        type="button"
        className={detail.headerButton}
        disabled={!recording.available || !hasDirectory || downloading}
        onClick={props.onDownload}
        title={downloadHint}
        aria-label="Скачать всю запись"
      >
        <RedesignIcon name={downloading ? "loading" : "download"} className={downloading ? detail.spinning : undefined} />
        <span className={detail.headerButtonLabel}>Скачать</span>
      </button>
      <button
        type="button"
        className={cn(detail.headerButton, detail.chatToggle)}
        aria-pressed={props.chatOpen}
        aria-controls={props.sideId}
        onClick={props.onToggleChat}
      >
        <RedesignIcon name={props.chatLabel === "Чат" ? "chat" : "bookmark"} />
        {props.chatLabel}
      </button>
      <button
        ref={props.moreRef}
        type="button"
        className={detail.headerButton}
        aria-label="Ещё: подробности, горячие клавиши"
        aria-haspopup="menu"
        aria-expanded={props.menuOpen}
        title="Ещё"
        onClick={props.onMore}
      >
        <RedesignIcon name="more" />
      </button>
    </header>
  );
}

function PlayerStage({
  state,
  url,
  error,
  playerRef,
  onRetry,
  onTime,
  onLoaded,
}: {
  state: PreviewState;
  url: string | null;
  error: string | null;
  playerRef: MutableRefObject<HlsPlayerHandle | null>;
  onRetry: () => void;
  onTime: (seconds: number) => void;
  onLoaded: () => void;
}) {
  return (
    <div className={detail.stage}>
      <div className={detail.stageFrame}>
        {state === "ready" && url ? (
          <HlsPlayer
            ref={playerRef}
            src={url}
            engine="hlsjs"
            hotkeys
            // The timeline below is the scrubbing surface; the player's own
            // bar cannot zoom and is useless on a multi-hour recording.
            hideSeekBar
            onTimeUpdate={onTime}
            onDurationChange={(value) => {
              if (value > 0) onLoaded();
            }}
          />
        ) : (
          <div className={cn(detail.placeholder, (state === "loading" || state === "pending") && detail.skeleton)}>
            {state === "loading" && <span className={detail.srOnly}>Открываю запись…</span>}
            {state === "pending" && <span>Запись только началась, первый фрагмент ещё пишется.</span>}
            {state === "gone" && (
              <>
                <RedesignIcon name="hidden" />
                <span>Видео этой записи уже удалено, чтобы освободить место на сервере. Метки и клипы остались.</span>
              </>
            )}
            {state === "error" && (
              <>
                <RedesignIcon name="alert" />
                <span>{error}</span>
                <button type="button" className={detail.retry} onClick={onRetry}>
                  Повторить
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
