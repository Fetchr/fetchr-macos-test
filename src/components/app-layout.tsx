import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { CommandPalette } from "@/components/command-palette";
import { OnboardingTour } from "@/ui/redesign/onboarding/OnboardingTour";
import { AddDialog } from "@/features/add/add-dialog";
import { DownloadOverlay } from "@/ui/redesign/simple";
import i18n, { ensureLocale } from "@/i18n";
import { ipc } from "@/lib/ipc";
import { MacAppShell, MacSidebar, useDockBadge, useMacMenu, useMacSidebar } from "@/ui/redesign/mac";
import { useBoot } from "@/stores/boot";
import { useLogs } from "@/stores/logs";
import { useQueue, useJobCounts } from "@/stores/queue";
import { defaultPerformanceSettings, useSettings, usesSimpleContent } from "@/stores/settings";
import { useUI } from "@/stores/ui";
import { useWorkflowPresets } from "@/stores/workflowPresets";
import { useFetchrMuteStore } from "@/stores/fetchrMute";
import { FetchrAppShell, QueueFlightLayer } from "@/ui/redesign/layout";
import { useScheduledRecordingWatcher } from "@/ui/redesign/live-recorder/useScheduledRecordingWatcher";
import { NavDockFrame, TopAppBar, type AppNavigationItemId } from "@/ui/redesign/topbar";
import { PageTransition } from "@/ui/redesign/layout/PageTransition";
import { FirstRunSetup } from "@/ui/redesign/setup/FirstRunSetup";
import { UpdateModal } from "@/ui/redesign/updates/UpdateModal";
import { useManualUpdateNotice } from "@/ui/redesign/updates/useManualUpdateNotice";
import { WhatsNewTrigger } from "@/ui/redesign/updates/WhatsNewTrigger";

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const macSidebar = useMacSidebar();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useScheduledRecordingWatcher();
  const togglePalette = useUI((s) => s.togglePalette);
  const openAdd = useUI((s) => s.openAddDialog);
  const openDownload = useUI((s) => s.openDownload);
  const downloadOpen = useUI((s) => s.downloadOpen);
  const introSettled = useBoot((s) => s.settled);
  const initQueue = useQueue((s) => s.init);
  const initLogs = useLogs((s) => s.init);
  const initFetchrMute = useFetchrMuteStore((s) => s.init);
  const setDirectory = useSettings((s) => s.setDirectory);
  const onboardingCompleted = useSettings((s) => s.onboardingCompleted);
  const setupCompleted = useSettings((s) => s.setupCompleted);
  const navPosition = useSettings((s) => s.navPosition);
  const uiMode = useSettings((s) => s.uiMode);
  const showOnboarding = useUI((s) => s.tourOpen);
  const openTour = useUI((s) => s.openTour);
  const closeTour = useUI((s) => s.closeTour);
  const locale = useSettings((s) => s.locale);
  const directory = useSettings((s) => s.directory);
  const maxConcurrentJobs = useSettings((s) => s.maxConcurrentJobs);
  const hardwarePresetApplied = useRef(false);

  useEffect(() => {
    void ipc.setQueueConcurrency(maxConcurrentJobs).catch(() => {});
  }, [maxConcurrentJobs]);
  const onboardingShown = useRef(false);
  const counts = useJobCounts();
  const m3u8Presets = useWorkflowPresets((s) => s.m3u8Presets);
  const activeM3u8PresetId = useWorkflowPresets((s) => s.activeM3u8PresetId);
  const setActiveM3u8Preset = useWorkflowPresets((s) => s.setActiveM3u8Preset);
  const createM3u8Preset = useWorkflowPresets((s) => s.createM3u8Preset);
  const updateM3u8Preset = useWorkflowPresets((s) => s.updateM3u8Preset);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    void initQueue().then((u) => unlisteners.push(u));
    void initLogs().then((u) => unlisteners.push(u));
    void initFetchrMute().then((u) => unlisteners.push(u));
    return () => unlisteners.forEach((u) => u());
  }, [initQueue, initLogs, initFetchrMute]);

  useEffect(() => {
    if (!directory) {
      void ipc.defaultDownloadDir().then((d) => {
        if (d) setDirectory(d);
      });
    }
  }, [directory, setDirectory]);

  useEffect(() => {
    if (i18n.language !== locale) {
      void ensureLocale(locale).then(() => i18n.changeLanguage(locale));
    }
  }, [locale]);

  useEffect(() => {
    if (hardwarePresetApplied.current) return;
    hardwarePresetApplied.current = true;
    void ipc.detectHardwarePreset().then((preset) => {
      const current = useSettings.getState();
      const profile = current.performance.profile ?? "auto";
      if (profile === "custom" || profile === "turbo") return;
      current.setPerformance({
        ...defaultPerformanceSettings,
        ...preset.performance,
      });
      current.setChatOverlay({
        ...current.chatOverlay,
        compose_mode: "direct",
        alpha_output_format: "mov_png",
        chat_overlay_fps: 18,
        save_alpha_overlay: false,
        save_clean_video: true,
      });
    }).catch(() => undefined);
  }, []);

  // Тур ждёт, пока заставка сядет в топбар и пройдёт первоначальная настройка.
  useEffect(() => {
    if (onboardingShown.current || onboardingCompleted || !introSettled || !setupCompleted) return;
    onboardingShown.current = true;
    const id = window.setTimeout(openTour, 600);
    return () => window.clearTimeout(id);
  }, [onboardingCompleted, introSettled, setupCompleted, openTour]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const isTyping = isEditableKeyboardEvent(e);

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        togglePalette();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (usesSimpleContent(useSettings.getState().uiMode)) openDownload();
        else openAdd();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        void navigate({ to: "/settings" });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void ipc.startQueue(maxConcurrentJobs);
        return;
      }
      if (!isTyping && e.key.toLowerCase() === "g") {
        const handler = (e2: KeyboardEvent) => {
          if (e2.defaultPrevented || e2.isComposing || isEditableKeyboardEvent(e2)) return;
          if (e2.key === "q") void navigate({ to: "/queue" });
          if (e2.key === "d" && usesSimpleContent(useSettings.getState().uiMode)) openDownload();
          if (e2.key === "l") void navigate({ to: "/logs" });
          if (e2.key === "f") void navigate({ to: "/finder" });
          if (e2.key === "c") void navigate({ to: "/chat-render" });
          if (e2.key === "p") void navigate({ to: "/sponsor-blur" });
          if (e2.key === "v") void navigate({ to: "/fetchr-mute" });
          if (e2.key === "r") void navigate({ to: "/vocal-remover" });
          if (e2.key === "i") void navigate({ to: "/live-recorder" });
          if (e2.key === "z") void navigate({ to: "/vps-recorder" });
          if (e2.key === "s") void navigate({ to: "/settings" });
          if (e2.key === "w") void navigate({ to: "/presets" });
          window.removeEventListener("keydown", handler);
        };
        window.addEventListener("keydown", handler, { once: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette, openAdd, navigate, maxConcurrentJobs]);

  // Смена режима в настройках переносит с экрана, которого в новом режиме нет.
  useEffect(() => {
    // M3U8 Finder в простом режиме растворён в поиске скачивания.
    if (usesSimpleContent(uiMode) && pathname.startsWith("/finder")) void navigate({ to: "/queue" });
    if (!usesSimpleContent(uiMode)) useUI.getState().closeDownload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiMode]);

  const activeCategory = useMemo<AppNavigationItemId>(() => {
    if (downloadOpen) return "download";
    if (pathname.startsWith("/finder")) return "finder";
    if (pathname.startsWith("/chat-render")) return "chat-render";
    if (pathname.startsWith("/sponsor-blur")) return "sponsor-blur";
    if (pathname.startsWith("/fetchr-mute")) return "fetchr-mute";
    if (pathname.startsWith("/vocal-remover")) return "vocal-remover";
    if (pathname.startsWith("/logs")) return "logs";
    if (pathname.startsWith("/settings")) return "settings";
    if (pathname.startsWith("/live-recorder")) return "live-recorder";
    if (pathname.startsWith("/vps-recorder")) return "vps-recorder";
    return "queue";
  }, [pathname, downloadOpen]);

  const navigateCategory = (itemId: AppNavigationItemId) => {
    if (itemId === "finder") {
      setActiveM3u8Preset(null);
      void navigate({ to: "/finder" });
    }
    else if (itemId === "download") openDownload();
    else if (itemId === "chat-render") void navigate({ to: "/chat-render" });
    else if (itemId === "sponsor-blur") void navigate({ to: "/sponsor-blur" });
    else if (itemId === "fetchr-mute") void navigate({ to: "/fetchr-mute" });
    else if (itemId === "vocal-remover") void navigate({ to: "/vocal-remover" });
    else if (itemId === "logs") void navigate({ to: "/logs" });
    else if (itemId === "settings") void navigate({ to: "/settings" });
    else if (itemId === "live-recorder") void navigate({ to: "/live-recorder" });
    else if (itemId === "vps-recorder") void navigate({ to: "/vps-recorder" });
    else void navigate({ to: "/queue" });
  };

  const macShell = uiMode === "macos";
  useLayoutEffect(() => {
    document.documentElement.dataset.uiStyle = macShell ? "macos" : "fetchr";
  }, [macShell]);

  useDockBadge(counts.queued + counts.running);
  const manualUpdate = useManualUpdateNotice();
  useMacMenu({
    navigate: (section) => {
      if (section === "presets") void navigate({ to: "/presets" });
      else navigateCategory(section as AppNavigationItemId);
    },
    openSettings: () => void navigate({ to: "/settings" }),
    addLink: () => (usesSimpleContent(uiMode) ? openDownload() : openAdd()),
    openPalette: togglePalette,
    startQueue: () => void ipc.startQueue(maxConcurrentJobs),
    toggleSidebar: macSidebar.toggle,
    openWhatsNew: () => useUI.getState().openWhatsNew(),
    checkUpdates: manualUpdate.checkNow,
    openHelpSite: () => void openUrl("https://fetchr.fun").catch(() => undefined),
    openTour,
  });

  const navProps = {
    activeCategory,
    onNavigate: navigateCategory,
    queueCount: counts.queued + counts.running,
    errorCount: counts.error,
    m3u8Presets,
    activeM3u8PresetId,
    onSelectM3u8Preset: (presetId: string | null) => {
      setActiveM3u8Preset(presetId);
      void navigate({ to: "/finder" });
    },
    onCreateM3u8Preset: () => {
      const id = createM3u8Preset(null);
      updateM3u8Preset(id, { name: "Новый канал", streamer: "" });
      void navigate({ to: "/finder" });
    },
  };

  const renderTopBar = (variant: "default" | "mac") => (
    <TopAppBar
      variant={variant}
      version={__APP_VERSION__}
      activeCategory={activeCategory}
      onNavigate={navigateCategory}
      queueCount={counts.queued + counts.running}
      errorCount={counts.error}
      m3u8Presets={m3u8Presets}
      activeM3u8PresetId={activeM3u8PresetId}
      onSelectM3u8Preset={navProps.onSelectM3u8Preset}
      onCreateM3u8Preset={navProps.onCreateM3u8Preset}
      onOpenSettings={() => void navigate({ to: "/settings" })}
      navPosition={navPosition}
    />
  );
  const page = <PageTransition routeKey={pathname}>{children}</PageTransition>;

  const shell = macShell ? (
    <MacAppShell
      title={sectionTitle(pathname, activeCategory, t)}
      sidebarVisible={macSidebar.visible}
      onToggleSidebar={macSidebar.toggle}
      toolbarActions={renderTopBar("mac")}
      sidebar={
        <MacSidebar
          version={__APP_VERSION__}
          activeCategory={activeCategory}
          onNavigate={navigateCategory}
          queueCount={counts.queued + counts.running}
          errorCount={counts.error}
        />
      }
    >
      {page}
    </MacAppShell>
  ) : (
    <FetchrAppShell mainPadding={0} topBarHeight={navPosition === "top" ? 76 : 35} topBar={renderTopBar("default")}>
      <NavDockFrame position={navPosition} navProps={navProps}>
        {page}
      </NavDockFrame>
    </FetchrAppShell>
  );

  return (
    <>
      {shell}
        <CommandPalette />
        <AddDialog />
        {usesSimpleContent(uiMode) && <DownloadOverlay />}
        <QueueFlightLayer />
        <UpdateModal />
        <WhatsNewTrigger />
        {introSettled && !setupCompleted && <FirstRunSetup />}
        {showOnboarding && (
          <OnboardingTour
            onClose={closeTour}
            onNavigate={(path) => void navigate({ to: path as '/' })}
          />
        )}
    </>
  );
}

/** Заголовок тулбара на macOS: название открытого раздела. */
function sectionTitle(
  pathname: string,
  category: AppNavigationItemId,
  t: TFunction,
): string {
  if (pathname.startsWith("/presets")) return t("mac.presets", "Пресеты");
  // Новый интерфейс зовёт очередь «Загрузки», как и боковая панель.
  if (category === "queue") return t("nav.downloads", "Загрузки");
  return t(`nav.${category.replaceAll("-", "_")}`);
}

function isEditableKeyboardEvent(event: KeyboardEvent): boolean {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];

  return path.some((node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.isContentEditable) return true;

    const tagName = node.tagName;
    if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return true;

    const role = node.getAttribute("role");
    return role === "textbox" || role === "searchbox" || role === "combobox";
  });
}
