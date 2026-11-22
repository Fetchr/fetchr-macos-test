import { getCurrentWindow } from "@tauri-apps/api/window";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";


import { BrandMark } from "@/ui/redesign/brand/FetchrBrand";
import { cn } from "@/lib/utils";
import { IS_MACOS } from "@/lib/platform";
import { useLogs } from "@/stores/logs";
import { useQueue } from "@/stores/queue";
import { speedBpsFromLogLine } from "@/ui/redesign/queue/progressSpeed";
import type { M3U8StreamerPreset } from "@/stores/workflowPresets";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { useWhatsNewButton } from "@/ui/redesign/updates/WhatsNewTrigger";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { useUI } from "@/stores/ui";
import type { NavPosition } from "@/stores/settings";

import type { AppNavigationItemId } from "./navigationTypes";
import { ActivityPanel } from "./activity/ActivityPanel";
import { NavRow } from "./NavRow";
import styles from "./TopAppBar.module.css";

export interface TopAppBarProps {
  version: string;
  activeCategory: AppNavigationItemId;
  onNavigate: (category: AppNavigationItemId) => void;
  queueCount?: number;
  errorCount?: number;
  m3u8Presets?: readonly M3U8StreamerPreset[];
  activeM3u8PresetId?: string | null;
  onSelectM3u8Preset?: (presetId: string | null) => void;
  onCreateM3u8Preset?: () => void;
  onOpenSettings: () => void;
  highlightedMode?: string | null;
  /** Не сверху — строка с вкладками не рисуется, её показывает NavDock. */
  navPosition?: NavPosition;
  /** "mac" — только кнопки действий, их ставит тулбар MacAppShell. */
  variant?: "default" | "mac";
  className?: string;
}

export function TopAppBar({
  version,
  activeCategory,
  onNavigate,
  queueCount = 0,
  errorCount = 0,
  m3u8Presets = [],
  activeM3u8PresetId = null,
  onSelectM3u8Preset,
  onCreateM3u8Preset,
  onOpenSettings,
  highlightedMode = null,
  navPosition = "top",
  variant = "default",
  className,
}: TopAppBarProps) {
  const { t } = useTranslation();
  // macOS shows native traffic-light controls (titleBarStyle: Overlay). Hide our
  // custom min/max/close there and inset the title row so the brand clears them.
  const isMac = IS_MACOS;
  const isMacToolbar = variant === "mac";
  const openWhatsNew = useUI((s) => s.openWhatsNew);
  const showWhatsNew = useWhatsNewButton();
  const openPalette = useUI((s) => s.openPalette);

  const status = useQueue(
    useShallow((state) => {
      let downloads = 0;
      let downloadBps = 0;
      let downloadEta: string | null = null;
      let renders = 0;
      let renderSpeedX: number | null = null;
      let renderFps: number | null = null;
      let processing = 0; // fetchr mute / vocal remover
      let processingPct: number | null = null;
      let lives = 0;
      let errors = 0;
      for (const job of state.jobs) {
        if (job.status === "error") {
          errors += 1;
          continue;
        }
        if (job.status !== "running") continue;
        const msg = job.progress.message ?? "";
        const speedStr = job.progress.speed ?? "";
        const isRender =
          job.spec.job_kind === "chat" ||
          /video-fps|chat-fps|chat pipe|Direct render|Рендер|qtrle|png \(MOV/i.test(msg) ||
          /wall/i.test(speedStr);
        const isProcessing = /Fetchr Mute|мат|Vocal/i.test(msg);
        if (isRender) {
          renders += 1;
          const x = `${speedStr} ${msg}`.match(/([\d.,]+)\s*x/i);
          if (x) {
            const parsed = Number.parseFloat(x[1].replace(",", "."));
            if (Number.isFinite(parsed)) renderSpeedX = Math.max(renderSpeedX ?? 0, parsed);
          }
          const fps = msg.match(/([\d.,]+)\s*video-fps/i);
          if (fps) renderFps = Number.parseFloat(fps[1].replace(",", "."));
        } else if (isProcessing) {
          processing += 1;
          processingPct = job.progress.stage_percent ?? job.progress.percent ?? null;
        } else if (job.spec.mode === "live") {
          lives += 1;
        } else {
          downloads += 1;
          downloadBps +=
            job.progress.speed_bps ||
            parseSpeedToBps(job.progress.speed) ||
            speedBpsFromLogLine(useLogs.getState().lastLineByJob[job.id]) ||
            0;
          if (!downloadEta && job.progress.eta) downloadEta = job.progress.eta;
        }
      }
      return {
        downloads,
        downloadBps,
        downloadEta,
        renders,
        renderSpeedX,
        renderFps,
        processing,
        processingPct,
        lives,
        errors,
      };
    })
  );

  const [activityOpen, setActivityOpen] = useState(false);
  const widgetRef = useRef<HTMLDivElement>(null);

  const hasRunning =
    status.downloads > 0 || status.renders > 0 || status.processing > 0 || status.lives > 0;
  const showWidget = hasRunning || status.errors > 0;

  const speedUnit = t("topbar.speed_unit", "Mbps");
  const speedDisplay = `${((status.downloadBps * 8) / 1000000).toFixed(1)} ${speedUnit}`;
  const renderDisplay =
    status.renderSpeedX != null
      ? `${status.renderSpeedX.toFixed(2)}x`
      : status.renderFps != null
        ? `${Math.round(status.renderFps)} fps`
        : "...";
  const processingDisplay =
    status.processingPct != null ? `${status.processingPct.toFixed(0)}%` : "...";

  const actionItems: ReactNode = (
    <>
          {activityOpen && (
            <ActivityPanel
              anchor={widgetRef.current}
              onClose={() => setActivityOpen(false)}
              onOpenQueue={() => onNavigate("queue")}
            />
          )}
          {showWidget && (
            <div
              ref={widgetRef}
              aria-expanded={activityOpen}
              className={cn(
                styles.statusWidget,
                hasRunning ? styles.statusWidgetActive : styles.statusWidgetError
              )}
              role="button"
              tabIndex={0}
              style={{ cursor: "pointer" }}
              title="Подробные загрузки"
              onClick={() => setActivityOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setActivityOpen((open) => !open);
              }}
            >
              <span className={styles.statusWidgetDot} />
              {hasRunning ? (
                <div className={styles.statusWidgetItems}>
                  {status.downloads > 0 && (
                    <span
                      className={styles.statusWidgetItem}
                      title={`${t("topbar.downloads", "Скачивания")}: ${status.downloads}${status.downloadEta ? ` · ETA ${status.downloadEta}` : ""}`}
                    >
                      <RedesignIcon name="download" className="size-3.5" />
                      <span className={styles.statusWidgetCount}>
                        {speedDisplay}
                        {status.downloads > 1 ? ` ·${status.downloads}` : ""}
                      </span>
                    </span>
                  )}
                  {status.renders > 0 && (
                    <span
                      className={styles.statusWidgetItem}
                      title={`${t("topbar.renders", "Рендер")}: ${status.renders}${status.renderFps != null ? ` · ${Math.round(status.renderFps)} video-fps` : ""}`}
                    >
                      <RedesignIcon name="chat" className="size-3.5" />
                      <span className={styles.statusWidgetCount}>
                        {renderDisplay}
                        {status.renders > 1 ? ` ·${status.renders}` : ""}
                      </span>
                    </span>
                  )}
                  {status.processing > 0 && (
                    <span
                      className={styles.statusWidgetItem}
                      title={t("topbar.processing", "Обработка аудио (Mute/Vocal)")}
                    >
                      <RedesignIcon name="audio" className="size-3.5" />
                      <span className={styles.statusWidgetCount}>
                        {processingDisplay}
                        {status.processing > 1 ? ` ·${status.processing}` : ""}
                      </span>
                    </span>
                  )}
                  {status.lives > 0 && (
                    <span
                      className={styles.statusWidgetItem}
                      title={t("topbar.live", "Запись стримов")}
                    >
                      <RedesignIcon name="live" className="size-3.5" />
                      <span className={styles.statusWidgetCount}>{status.lives}</span>
                    </span>
                  )}
                  {status.errors > 0 && (
                    <span className={styles.statusWidgetItem} title={t("topbar.errors", "Ошибки")}>
                      <RedesignIcon name="alert" className="size-3.5" />
                      <span className={styles.statusWidgetCount}>{status.errors}</span>
                    </span>
                  )}
                </div>
              ) : (
                <span
                  className={styles.statusWidgetItem}
                  title={t("topbar.errors", "Ошибки")}
                >
                  <RedesignIcon name="alert" className="size-3.5" />
                  <span className={styles.statusWidgetCount}>{status.errors}</span>
                </span>
              )}
            </div>
          )}

          {/* Обновления ставятся сами при запуске; сутки после этого здесь
              кнопка с новостями версии. */}
          {showWhatsNew && (
            <button
              className={cn(styles.iconButton, styles.updateIconButton)}
              type="button"
              aria-label={t("topbar.whats_new", "Что нового")}
              onClick={openWhatsNew}
              title={t("topbar.whats_new", "Что нового")}
            >
              <RedesignIcon name="sparkle" className="size-4" />
            </button>
          )}

          {/* Поиск открывает командную палитру — она и есть поисковая
              поверхность приложения, до сих пор доступная только по Ctrl+K. */}
          <button
            className={styles.iconButton}
            type="button"
            aria-label={t("topbar.search", "Поиск")}
            title={`${t("topbar.search", "Поиск")} · ${isMac ? "⌘K" : "Ctrl+K"}`}
            onClick={openPalette}
          >
            <RedesignIcon name="finder" />
          </button>

          <button
            data-tour="nav-settings"
            className={cn(styles.iconButton, activeCategory === "settings" && styles.iconButtonActive)}
            type="button"
            aria-label={t("nav.settings", "Настройки")}
            onClick={onOpenSettings}
          >
            <RedesignIcon name="settings" />
          </button>
    </>
  );

  if (isMacToolbar) {
    return (
      <div className={cn(fetchrThemeClassName, "no-drag", styles.actions, styles.macActions, className)}>
        {actionItems}
      </div>
    );
  }

  return (
    <div className={cn(fetchrThemeClassName, "drag-region", styles.topBar, navPosition !== "top" && styles.topBarSlim, className)}>
      <div
        className={styles.titleRow}
        style={isMac ? { paddingLeft: 72 } : undefined}
      >
        <div className={styles.brandGroup}>
          <div className={styles.brandMark} aria-hidden data-intro-anchor="mark">
            <BrandMark className={styles.brandImage} />
          </div>
          <div className={styles.brandText}>
            <span className="sr-only">Fetchr</span>
            <span className={styles.version} data-intro-anchor="version">
              {version}
            </span>
          </div>
        </div>

        <div className={cn("no-drag", styles.actions)}>
          {actionItems}
          {!isMac && (
            <>
              <div className={styles.windowDivider} aria-hidden />
              <div className={styles.windowControls}>
                <button
                  className={styles.windowButton}
                  type="button"
                  aria-label="Minimize"
                  onClick={() => void getCurrentWindow().minimize()}
                >
                  <RedesignIcon name="minimize" className="size-4" />
                </button>
                <button
                  className={styles.windowButton}
                  type="button"
                  aria-label="Maximize"
                  onClick={() => void getCurrentWindow().toggleMaximize()}
                >
                  <RedesignIcon name="stop" className="size-3.5" />
                </button>
                <button
                  className={cn(styles.windowButton, styles.closeWindowButton)}
                  type="button"
                  aria-label="Close"
                  onClick={() => void getCurrentWindow().close()}
                >
                  <RedesignIcon name="close" className="size-4" />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {navPosition === "top" && (
        <div className={styles.workspaceRow}>
          <NavRow
            activeCategory={activeCategory}
            onNavigate={onNavigate}
            queueCount={queueCount}
            errorCount={errorCount}
            m3u8Presets={m3u8Presets}
            activeM3u8PresetId={activeM3u8PresetId}
            onSelectM3u8Preset={onSelectM3u8Preset}
            onCreateM3u8Preset={onCreateM3u8Preset}
            highlightedMode={highlightedMode}
          />
        </div>
      )}


    </div>
  );
}

function parseSpeedToBps(value?: string | null): number {
  if (!value) return 0;
  const normalized = value.replace(/ps$/i, "/s");
  const match = normalized.match(/(\d+(?:[.,]\d+)?)\s*([KMGT]?i?B|[KMGT]?B)\/s/i);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return 0;

  const unit = match[2].toLowerCase();
  let multiplier = 1;
  if (unit.startsWith("k")) multiplier = 1024;
  else if (unit.startsWith("m")) multiplier = 1024 ** 2;
  else if (unit.startsWith("g")) multiplier = 1024 ** 3;
  else if (unit.startsWith("t")) multiplier = 1024 ** 4;

  return amount * multiplier;
}
