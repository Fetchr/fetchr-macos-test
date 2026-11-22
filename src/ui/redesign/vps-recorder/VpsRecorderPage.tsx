import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { useVpsRecorderStore } from "@/stores/vpsRecorder";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { fetchrThemeClassName } from "@/ui/redesign/theme";

import type { VpsArchiveSection } from "@/stores/vpsRecorder";

import { ArchiveCommandBar, isRecordingSection, type RecordingFilter } from "./ArchiveCommandBar";
import { archiveChannels, clipsBySession, isLive, isOnAir, recordingTitle } from "./archiveModel";
import type { SearchHit } from "./archiveSearchModel";
import layout from "./ArchiveLayout.module.css";
import { ClipsLibrary } from "./ClipsLibrary";
import { HostingChoice } from "./HostingChoice";
import { ManagedServerPanel } from "./ManagedServerPanel";
import { RecordingDetail, type SeekRequest } from "./RecordingDetail";
import { RecordingList } from "./RecordingList";
import { ServerStoragePanel, SourceSwitch } from "./ServerStorage";
import { useVisibleClips, useVisibleRecordings } from "./usePendingDeletes";
import { VpsConnectPanel } from "./VpsConnectPanel";
import { WatchTargets } from "./WatchTargets";
import styles from "./VpsRecorderPage.module.css";

const AUTO_CONNECT_ATTEMPTS = 3;
const AUTO_CONNECT_BACKOFF_MS = 5000;

const PANE_LABEL: Record<VpsArchiveSection, string> = {
  all: "Открытая запись",
  live: "Открытая запись",
  withClips: "Открытая запись",
  clips: "Клипы",
  channels: "Каналы и расписание",
  server: "Сервер",
};

export function VpsRecorderPage() {
  const config = useVpsRecorderStore((s) => s.config);
  const configLoaded = useVpsRecorderStore((s) => s.configLoaded);
  const tunnel = useVpsRecorderStore((s) => s.tunnel);
  const status = useVpsRecorderStore((s) => s.status);
  const statusError = useVpsRecorderStore((s) => s.statusError);
  // Items whose delete can still be undone are hidden everywhere on the page.
  const recordings = useVisibleRecordings(useVpsRecorderStore((s) => s.recordings));
  const recordingsLoaded = useVpsRecorderStore((s) => s.recordingsLoaded);
  const clips = useVisibleClips(useVpsRecorderStore((s) => s.clips));
  const flushDeletes = useVpsRecorderStore((s) => s.flushDeletes);
  const busy = useVpsRecorderStore((s) => s.busy);
  const loadConfig = useVpsRecorderStore((s) => s.loadConfig);
  const connect = useVpsRecorderStore((s) => s.connect);
  const refreshTunnel = useVpsRecorderStore((s) => s.refreshTunnel);
  const refreshStatus = useVpsRecorderStore((s) => s.refreshStatus);
  const refreshClips = useVpsRecorderStore((s) => s.refreshClips);
  const refreshRecordings = useVpsRecorderStore((s) => s.refreshRecordings);
  const refreshSchedules = useVpsRecorderStore((s) => s.refreshSchedules);
  const connectError = useVpsRecorderStore((s) => s.connectError);
  const connectFailures = useVpsRecorderStore((s) => s.connectFailures);
  const requestedSection = useVpsRecorderStore((s) => s.requestedSection);
  const requestSection = useVpsRecorderStore((s) => s.requestSection);
  const resetConnectFailures = useVpsRecorderStore((s) => s.resetConnectFailures);
  const managedFailures = useVpsRecorderStore((s) => s.managedFailures);

  // Section, channel, search and the open recording live in the store, so
  // coming back to the page lands where the user left it.
  const view = useVpsRecorderStore((s) => s.view);
  const setView = useVpsRecorderStore((s) => s.setView);
  const { section, channel, query, picked } = view;
  const setQuery = (next: string) => setView({ query: next });
  // Only an explicit pick scrolls to the player; an auto-opened one does not.
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  // Перемотка, запрошенная из поиска (метка или клип); только для открытой записи.
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);
  // Stable, so memoised list rows skip re-rendering on every poll.
  const selectRecording = useCallback(
    (session: string) => {
      setView({ picked: session });
      setScrollTo(session);
    },
    [setView],
  );

  const managed = useVpsRecorderStore((s) => s.managed);
  const managedLoaded = useVpsRecorderStore((s) => s.managedLoaded);
  const managedOnline = useVpsRecorderStore((s) => s.managedOnline);
  const managedError = useVpsRecorderStore((s) => s.managedError);
  const loadManaged = useVpsRecorderStore((s) => s.loadManaged);
  const connectManaged = useVpsRecorderStore((s) => s.connectManaged);
  const probeManaged = useVpsRecorderStore((s) => s.probeManaged);

  const ownConfigured = Boolean(config.host);
  const useManaged = managed.active;
  const configured = ownConfigured || managed.available;
  const online = useManaged ? managedOnline === true : tunnel.phase === "online";
  const triedManaged = useRef(false);

  useEffect(() => {
    // A new visit gets the full automatic-reconnect budget again.
    resetConnectFailures();
    void loadConfig();
    void loadManaged();
    void refreshTunnel();
  }, [loadConfig, loadManaged, refreshTunnel, resetConnectFailures]);

  // Leaving the page (or closing the app) does not drop a delete waiting out
  // its undo window: it is sent right away.
  useEffect(() => {
    const onUnload = () => void flushDeletes();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      void flushDeletes();
    };
  }, [flushDeletes]);

  // A buyer never types anything: once a plan is paid (or granted), the Fetchr
  // archive shows up the first time this page opens. Next to an own VPS it is
  // only attached, not switched to — the own VPS stays what the user sees.
  useEffect(() => {
    if (!configLoaded || !managedLoaded || managed.available || triedManaged.current) return;
    triedManaged.current = true;
    void connectManaged(true, !ownConfigured);
  }, [configLoaded, managedLoaded, managed.available, ownConfigured, connectManaged]);

  // Opening the page reconnects the own VPS: its tunnel does not survive an
  // app restart. It stays up while the Fetchr archive is shown. Failed attempts
  // back off and stop after a few: hammering SSH gets the IP banned (fail2ban).
  useEffect(() => {
    if (!configLoaded || !ownConfigured || tunnel.phase === "online" || busy.connect) return;
    if (connectFailures >= AUTO_CONNECT_ATTEMPTS) return;
    const delay = connectFailures === 0 ? 0 : AUTO_CONNECT_BACKOFF_MS * 2 ** (connectFailures - 1);
    const timer = window.setTimeout(() => void connect(), delay);
    return () => window.clearTimeout(timer);
  }, [configLoaded, ownConfigured, tunnel.phase, busy.connect, connectFailures, connect]);

  // A toast action ("Открыть в Клипах") asks for a section from outside.
  useEffect(() => {
    if (!requestedSection) return;
    requestSection(null);
    setView({ section: requestedSection, channel: null });
  }, [requestedSection, requestSection, setView]);

  // The Fetchr archive is probed when shown and, after a failure, retried with
  // the same backoff and budget as the own VPS.
  const probing = Boolean(busy.probe);
  useEffect(() => {
    if (!useManaged || probing || managedOnline === true) return;
    if (managedFailures >= AUTO_CONNECT_ATTEMPTS) return;
    const delay =
      managedOnline === null || managedFailures === 0 ? 0 : AUTO_CONNECT_BACKOFF_MS * 2 ** (managedFailures - 1);
    const timer = window.setTimeout(() => void probeManaged(), delay);
    return () => window.clearTimeout(timer);
  }, [useManaged, probing, managedOnline, managedFailures, probeManaged]);

  useEffect(() => {
    if (!online) return;
    // A poll is skipped while the window is hidden or the previous one is
    // still in flight: a slow archive must not pile requests up on itself.
    const inFlight = { quick: false, slow: false };
    const guarded = (key: keyof typeof inFlight, run: () => Promise<unknown>) => {
      if (inFlight[key] || document.visibilityState === "hidden") return;
      inFlight[key] = true;
      void run().finally(() => {
        inFlight[key] = false;
      });
    };
    const load = () => guarded("quick", () => Promise.all([refreshStatus(), refreshRecordings()]));
    const library = () => guarded("slow", () => Promise.all([refreshClips(), refreshSchedules()]));
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      load();
      library();
    };
    document.addEventListener("visibilitychange", onVisible);
    load();
    library();
    const quick = window.setInterval(load, 3000);
    const slow = window.setInterval(library, 10000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(quick);
      window.clearInterval(slow);
    };
  }, [online, refreshStatus, refreshRecordings, refreshClips, refreshSchedules]);

  const displayed = useMemo(() => {
    const items = [...recordings];
    const current = status?.recording;
    if (current && !items.some((item) => item.session === current.session)) {
      items.unshift({
        session: current.session,
        channel: current.channel,
        title: current.title ?? null,
        started_at: current.started_at,
        ended_at: null,
        duration: current.duration ?? current.position ?? 0,
        available_start: current.available_start ?? 0,
        segments: current.segments ?? 0,
        video_size: current.video_size ?? 0,
        chat_messages: current.chat_messages ?? 0,
        status: "recording",
        available: (current.segments ?? 0) > 0 || (current.position ?? 0) > 1,
        markers: [],
        gaps: [],
      });
    }
    return items;
  }, [recordings, status?.recording]);

  const channels = useMemo(() => archiveChannels(status, displayed), [status, displayed]);
  const clipCounts = useMemo(() => clipsBySession(clips), [clips]);

  // Идущие эфиры сверху, остальное от новых к старым.
  const sorted = useMemo(
    () =>
      [...displayed].sort(
        (a, b) => Number(isLive(b)) - Number(isLive(a)) || b.started_at - a.started_at,
      ),
    [displayed],
  );

  const recordingSection = isRecordingSection(section);
  const listed = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sorted.filter((recording) => {
      if (channel && recording.channel?.toLowerCase() !== channel.toLowerCase()) return false;
      if (section === "live" && !isLive(recording)) return false;
      if (section === "withClips" && !clipCounts.get(recording.session)) return false;
      if (!needle) return true;
      return `${recordingTitle(recording)} ${recording.channel ?? ""}`.toLowerCase().includes(needle);
    });
  }, [sorted, channel, section, query, clipCounts]);

  // Без явного выбора открыта первая запись списка: правая колонка не пустует.
  const active = useMemo(
    () => listed.find((item) => item.session === picked) ?? listed.find((item) => isOnAir(item) || !isLive(item)) ?? null,
    [listed, picked],
  );

  // Pin whatever is open: otherwise a new live session sorted on top would
  // replace it and drop the range, player position and typed names.
  useEffect(() => {
    if (active && active.session !== picked) setView({ picked: active.session });
  }, [active, picked, setView]);

  // Чипы считают внутри выбранного канала, чтобы число совпадало с тем, что покажет фильтр.
  const filterCounts = useMemo(() => {
    const pool = channel
      ? displayed.filter((item) => item.channel?.toLowerCase() === channel.toLowerCase())
      : displayed;
    return {
      all: pool.length,
      live: pool.filter(isLive).length,
      withClips: pool.filter((item) => clipCounts.has(item.session)).length,
    };
  }, [displayed, channel, clipCounts]);
  const openSection = (next: VpsArchiveSection) => setView({ section: next, channel: null });
  const openFilter = (next: RecordingFilter) => setView({ section: next });
  const openChannel = (name: string | null) =>
    setView({ channel: name, section: recordingSection ? section : "all" });

  // Выбор из поиска открывает запись поверх любых фильтров и, для метки или
  // клипа, перематывает к моменту.
  const openHit = (hit: SearchHit) => {
    if (!hit.session) {
      setView({ section: "clips", channel: null, query: "" });
      return;
    }
    setView({ section: "all", channel: null, query: "", picked: hit.session });
    setScrollTo(hit.session);
    if (hit.at != null) setSeekRequest({ session: hit.session, at: hit.at, nonce: Date.now() });
  };

  const listTitle = channel ?? "Записи";

  const offlineError = online
    ? null
    : useManaged
      ? managedError
      : connectError || tunnel.error;
  const failures = useManaged ? managedFailures : connectFailures;
  const autoExhausted = !online && failures >= AUTO_CONNECT_ATTEMPTS;
  // A failed status poll matters even with the tunnel up: the recorder may be down.
  const error =
    offlineError ||
    (statusError ? `Сервер не отвечает на запросы. ${statusError}` : null) ||
    (autoExhausted ? "Нет связи с сервером." : null);
  const retrying = useManaged ? probing : Boolean(busy.connect);
  const retryNote = online
    ? null
    : autoExhausted
      ? "Автопопытки закончились. Нажмите «Повторить»."
      : failures > 0
        ? `Повторяю автоматически: попытка ${Math.min(failures + 1, AUTO_CONNECT_ATTEMPTS)} из ${AUTO_CONNECT_ATTEMPTS}.`
        : null;
  const retry = () => void (useManaged ? probeManaged() : connect());

  if (!configured) {
    return (
      <div className={cn(fetchrThemeClassName, layout.host, styles.page)}>
        <div className={styles.scroll}>
          <div className={styles.inner}>
            <HostingChoice />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(fetchrThemeClassName, layout.host)}>
      <div className={cn(layout.archive, !recordingSection && layout.archiveWide)}>
        <ArchiveCommandBar
          section={section}
          channel={channel}
          channels={channels}
          filterCounts={filterCounts}
          clipCount={clips.length}
          online={online}
          query={query}
          onQuery={setQuery}
          recordings={sorted}
          clips={clips}
          onPick={openHit}
          onFilter={openFilter}
          onChannel={openChannel}
          onSection={openSection}
        />

        {recordingSection && (
          <RecordingList
            title={listTitle}
            recordings={listed}
            clipCounts={clipCounts}
            selected={active?.session ?? null}
            onSelect={selectRecording}
            loading={!recordingsLoaded && !error && displayed.length === 0}
            emptyText={
              query
                ? `По запросу «${query.trim()}» ничего не нашлось. Проверьте название или очистите поиск.`
                : displayed.length === 0
                  ? "Записей пока нет. Добавьте канал: сервер начнёт писать сам, как только он выйдет в эфир."
                  : "В этом разделе пусто."
            }
          />
        )}

        <section className={layout.pane} aria-label={PANE_LABEL[section]}>
          <div className={layout.paneScroll}>
            {error && (
              <div className={layout.alert} role="alert">
                <RedesignIcon name="alert" className="size-4" />
                <span>
                  {error}
                  {retryNote && (
                    <>
                      <br />
                      <small>{retryNote}</small>
                    </>
                  )}
                </span>
                {!online && (
                  <button
                    type="button"
                    className={layout.alertAction}
                    disabled={retrying}
                    aria-busy={retrying || undefined}
                    onClick={retry}
                  >
                    {retrying ? "Подключаюсь…" : "Повторить"}
                  </button>
                )}
                {section !== "server" && (
                  <button type="button" className={layout.alertAction} onClick={() => openSection("server")}>
                    Настройки сервера
                  </button>
                )}
              </div>
            )}

            {recordingSection &&
              (active ? (
                <div key="detail" className={layout.paneFade}>
                  <RecordingDetail
                    key={active.session}
                    recording={active}
                    scrollOnOpen={scrollTo === active.session}
                    seekTo={seekRequest?.session === active.session ? seekRequest : null}
                  />
                </div>
              ) : (
                <div key="empty" className={layout.paneEmpty}>
                  <RedesignIcon name="video" className="size-6" />
                  <p>{displayed.length ? "Выберите запись слева." : "Здесь появится запись, когда канал выйдет в эфир."}</p>
                  {channels.length === 0 && (
                    <button type="button" className={layout.primary} onClick={() => openSection("channels")}>
                      Добавить канал
                    </button>
                  )}
                </div>
              ))}
            {section === "clips" && <ClipsLibrary clips={clips} showFilter />}
            {section === "channels" && <WatchTargets />}
            {section === "server" && (
              <>
                <SourceSwitch className={layout.sourceSwitch} />
                <ServerStoragePanel online={online} />
                {useManaged ? <ManagedServerPanel /> : <VpsConnectPanel />}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
