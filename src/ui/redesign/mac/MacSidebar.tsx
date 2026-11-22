import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";
import { BrandMark } from "@/ui/redesign/brand/FetchrBrand";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";
import { isToolEnabled } from "@/ui/redesign/setup/setupTools";
import type { AppNavigationItemId } from "@/ui/redesign/topbar";
import { NAV_ITEMS } from "@/ui/redesign/topbar/NavRow";

import styles from "./MacSidebar.module.css";

type NavItem = (typeof NAV_ITEMS)[number];

/** Группы панели в порядке HIG: сначала основная работа, служебное внизу. */
const GROUPS: Array<{ id: string; labelKey: string; fallback: string; items: AppNavigationItemId[] }> = [
  {
    id: "fetch",
    labelKey: "mac.group_fetch",
    fallback: "Скачивание",
    items: ["download", "queue", "finder", "live-recorder", "vps-recorder"],
  },
  {
    id: "process",
    labelKey: "mac.group_process",
    fallback: "Обработка",
    items: ["chat-render", "fetchr-mute", "vocal-remover", "sponsor-blur"],
  },
  { id: "more", labelKey: "mac.group_more", fallback: "Прочее", items: ["logs"] },
];

export interface MacSidebarProps {
  activeCategory: AppNavigationItemId;
  onNavigate: (category: AppNavigationItemId) => void;
  queueCount?: number;
  errorCount?: number;
  version: string;
}

export function MacSidebar({ activeCategory, onNavigate, queueCount = 0, errorCount = 0, version }: MacSidebarProps) {
  const { t } = useTranslation();
  const enabledTools = useSettings((s) => s.enabledTools);
  const simple = useSettings((s) => s.uiMode) === "simple";

  const isVisible = (item: NavItem) => {
    if (item.id === "download") return simple;
    if (item.id === "finder" && simple) return false;
    return isToolEnabled(enabledTools, item.id);
  };
  const byId = new Map(NAV_ITEMS.filter(isVisible).map((item) => [item.id as AppNavigationItemId, item]));

  const labelFor = (id: AppNavigationItemId) =>
    simple && id === "queue" ? t("nav.downloads", "Загрузки") : t(`nav.${id.replaceAll("-", "_")}`);

  const badgeFor = (id: AppNavigationItemId) => {
    if (id === "queue") return { count: queueCount, error: false };
    if (id === "logs") return { count: errorCount, error: true };
    return { count: 0, error: false };
  };

  return (
    <div className={styles.sidebar}>
      {/* Место под кнопки окна: тянется за ним всё окно. */}
      <div className={styles.titlebar} data-tauri-drag-region />

      <nav className={styles.scroll} aria-label={t("mac.sections", "Разделы Fetchr")}>
        {GROUPS.map((group) => {
          const items = group.items.flatMap((id) => {
            const item = byId.get(id);
            return item ? [item] : [];
          });
          if (items.length === 0) return null;
          return (
            <section key={group.id} className={styles.group} aria-labelledby={`mac-group-${group.id}`}>
              <h2 id={`mac-group-${group.id}`} className={styles.groupLabel}>
                {t(group.labelKey, group.fallback)}
              </h2>
              <ul className={styles.list} role="list">
                {items.map((item) => (
                  <SidebarRow
                    key={item.id}
                    id={item.id as AppNavigationItemId}
                    icon={item.icon}
                    label={labelFor(item.id as AppNavigationItemId)}
                    active={item.id === activeCategory}
                    badge={badgeFor(item.id as AppNavigationItemId)}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </nav>

      <div className={styles.footer} data-tauri-drag-region>
        <span className={styles.brandMark} aria-hidden data-intro-anchor="mark">
          <BrandMark className={styles.brandImage} />
        </span>
        <span className={styles.brandText} data-tauri-drag-region>
          Fetchr
          <span className={styles.version} data-intro-anchor="version">
            {version}
          </span>
        </span>
      </div>
    </div>
  );
}

interface SidebarRowProps {
  id: AppNavigationItemId;
  icon: RedesignIconName;
  label: string;
  active: boolean;
  badge: { count: number; error: boolean };
  onNavigate: (category: AppNavigationItemId) => void;
}

function SidebarRow({ id, icon, label, active, badge, onNavigate }: SidebarRowProps) {
  return (
    <li>
      <button
        type="button"
        data-tour={`nav-${id}`}
        data-nav-target={id}
        className={cn(styles.row, active && styles.rowActive)}
        aria-current={active ? "page" : undefined}
        onClick={() => onNavigate(id)}
      >
        <RedesignIcon name={icon} className={styles.icon} />
        <span className={styles.label}>{label}</span>
        {badge.count > 0 && (
          <span className={cn(styles.badge, badge.error && styles.badgeError)}>
            {badge.count > 99 ? "99+" : badge.count}
          </span>
        )}
      </button>
    </li>
  );
}
