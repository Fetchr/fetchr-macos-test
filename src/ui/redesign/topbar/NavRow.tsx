import { useTranslation } from "react-i18next";

import { useFlipIndicator } from "@/hooks/useFlipIndicator";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";
import type { M3U8StreamerPreset } from "@/stores/workflowPresets";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";
import { isToolEnabled } from "@/ui/redesign/setup/setupTools";

import type { AppNavigationItemId } from "./navigationTypes";
import styles from "./TopAppBar.module.css";
import { useCompactNav } from "./useCompactNav";

type NavItemId = Exclude<AppNavigationItemId, "settings">;

/** Labels come from the nav.* namespace; ids map to it by replacing hyphens. */
export const NAV_ITEMS: Array<{ id: NavItemId; icon: RedesignIconName }> = [
  // Только в простом режиме: поиск и мультивыбор заменяют ручной M3U8 Finder.
  { id: "download", icon: "download" },
  { id: "queue", icon: "queue" },
  { id: "live-recorder", icon: "live" },
  // Hidden until the password in Настройки → Интеграции unlocks it.
  { id: "vps-recorder", icon: "server" },
  { id: "finder", icon: "finder" },
  { id: "chat-render", icon: "chat" },
  { id: "sponsor-blur", icon: "blur" },
  { id: "fetchr-mute", icon: "mute" },
  { id: "vocal-remover", icon: "vocal" },
  { id: "logs", icon: "logs" },
];

export interface NavRowProps {
  activeCategory: AppNavigationItemId;
  onNavigate: (category: AppNavigationItemId) => void;
  queueCount?: number;
  errorCount?: number;
  m3u8Presets?: readonly M3U8StreamerPreset[];
  activeM3u8PresetId?: string | null;
  onSelectM3u8Preset?: (presetId: string | null) => void;
  onCreateM3u8Preset?: () => void;
  highlightedMode?: string | null;
  /** Горизонтальный ряд (сверху, снизу) или вертикальная колонка (слева, справа). */
  orientation?: "horizontal" | "vertical";
  /** Сторона окна, у которой стоит ряд: от неё зависит, куда раскрывается меню пресетов. */
  dock?: "top" | "bottom" | "left" | "right";
}

/**
 * Ряд вкладок разделов. Не знает, где стоит: верхняя панель кладёт его в
 * свою вторую строку, а NavDock ставит у любого края окна.
 */
export function NavRow({
  activeCategory,
  onNavigate,
  queueCount = 0,
  errorCount = 0,
  m3u8Presets = [],
  activeM3u8PresetId = null,
  onSelectM3u8Preset,
  onCreateM3u8Preset,
  highlightedMode = null,
  orientation = "horizontal",
  dock = "top",
}: NavRowProps) {
  const { t } = useTranslation();
  useFlipIndicator(activeCategory, "activeNavTab");
  const enabledTools = useSettings((s) => s.enabledTools);
  const uiMode = useSettings((s) => s.uiMode);
  const simple = uiMode === "simple";
  const vertical = orientation === "vertical";

  const visibleNavItems = NAV_ITEMS.filter((item) => {
    if (item.id === "download") return simple;
    if (item.id === "finder" && simple) return false;
    return isToolEnabled(enabledTools, item.id);
  });
  const { containerRef: navContainerRef, compact } = useCompactNav(
    visibleNavItems.map((item) => item.id).join(","),
  );
  const compactNav = compact && !vertical;

  return (
    <div
      ref={navContainerRef}
      data-orientation={orientation}
      data-dock={dock}
      className={cn("no-drag", styles.workspaceNavigation, compactNav && styles.workspaceNavigationCompact)}
    >
      <button
        className={styles.homeButton}
        type="button"
        aria-label={t("topbar.open_queue", "Открыть очередь")}
        onClick={() => onNavigate("queue")}
      >
        <RedesignIcon name="home" />
      </button>
      <div className={styles.workspaceDivider} aria-hidden />
      <nav className={styles.navTabs} aria-label="Разделы Fetchr">
        {visibleNavItems.map((item) => {
          const active = item.id === activeCategory;
          let badgeCount = 0;
          if (item.id === "queue") badgeCount = queueCount;
          if (item.id === "logs") badgeCount = errorCount;

          const label =
            simple && item.id === "queue" ? t("nav.downloads", "Загрузки") : t(`nav.${item.id.replaceAll("-", "_")}`);

          return (
            <div className={styles.navItemWithMenu} key={item.id}>
              <button
                data-tour={`nav-${item.id}`}
                data-nav-target={item.id}
                className={cn(
                  styles.navTab,
                  active && styles.navTabActive,
                  highlightedMode === item.id && styles.navTabHighlighted,
                )}
                type="button"
                aria-current={active ? "page" : undefined}
                aria-label={(compactNav || vertical) && !active ? label : undefined}
                title={compactNav || vertical ? label : undefined}
                onClick={() => onNavigate(item.id)}
              >
                <RedesignIcon name={item.icon} className={styles.navTabIcon} />
                <span className={styles.navTabLabel}>{label}</span>
                {badgeCount > 0 && (
                  <span data-nav-badge className={cn(styles.navTabBadge, item.id === "logs" && styles.navTabBadgeError)}>
                    {badgeCount > 99 ? "99+" : badgeCount}
                  </span>
                )}
                {active && <div data-flip-id="activeNavTab" className={styles.activeUnderline} />}
              </button>

              {item.id === "finder" && (
                <div className={styles.presetMenu} role="menu" aria-label="M3U8 presets">
                  <div className={styles.presetMenuHeader}>
                    <span>{t("topbar.m3u8_presets", "M3U8 presets")}</span>
                    <button
                      className={styles.presetAddButton}
                      type="button"
                      aria-label={t("topbar.create_m3u8_preset", "Создать M3U8 пресет")}
                      onClick={onCreateM3u8Preset}
                    >
                      <RedesignIcon name="add" />
                    </button>
                  </div>

                  <div className={styles.presetMenuList}>
                    <button
                      className={cn(styles.presetMenuButton, activeM3u8PresetId == null && styles.presetMenuButtonActive)}
                      type="button"
                      role="menuitem"
                      onClick={() => onSelectM3u8Preset?.(null)}
                    >
                      <span className={styles.presetMenuMain}>{t("topbar.no_preset", "Без пресета")}</span>
                      <span className={styles.presetMenuSub}>{t("topbar.manual_search", "Ручной поиск")}</span>
                    </button>

                    {m3u8Presets.length > 0 ? (
                      m3u8Presets.map((preset) => (
                        <button
                          className={cn(
                            styles.presetMenuButton,
                            preset.id === activeM3u8PresetId && styles.presetMenuButtonActive,
                          )}
                          type="button"
                          role="menuitem"
                          key={preset.id}
                          onClick={() => onSelectM3u8Preset?.(preset.id)}
                        >
                          <span className={styles.presetMenuMain}>{preset.name}</span>
                          <span className={styles.presetMenuSub}>
                            {preset.streamer || t("topbar.streamer_not_set", "Никнейм не задан")}
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className={styles.presetMenuEmpty}>{t("topbar.no_presets_yet", "Пресетов пока нет")}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
}
