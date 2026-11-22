import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { IS_MACOS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { fetchrThemeClassName } from "@/ui/redesign/theme";

import styles from "./MacAppShell.module.css";
import { MacWindowControls } from "./MacWindowControls";

export interface MacAppShellProps {
  sidebar: ReactNode;
  title: string;
  toolbarActions: ReactNode;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  children: ReactNode;
}

/**
 * Окно Fetchr на macOS по HIG и Liquid Glass (macOS 26): плавающая стеклянная
 * боковая панель с кнопками окна, единый тулбар с заголовком раздела и
 * стеклянными капсулами действий. Контент остаётся непрозрачным.
 *
 * WKWebView не понимает -webkit-app-region, поэтому окно тянется за элементы
 * с data-tauri-drag-region.
 */
export function MacAppShell({
  sidebar,
  title,
  toolbarActions,
  sidebarVisible,
  onToggleSidebar,
  children,
}: MacAppShellProps) {
  const { t } = useTranslation();
  const toggleLabel = sidebarVisible
    ? t("mac.hide_sidebar", "Скрыть боковую панель")
    : t("mac.show_sidebar", "Показать боковую панель");

  return (
    <div className={cn(fetchrThemeClassName, styles.shell)} data-sidebar={sidebarVisible ? "visible" : "hidden"}>
      {/* inert убирает скрытую панель из Tab-порядка; в типах React 18 его нет. */}
      <aside className={styles.sidebar} aria-hidden={!sidebarVisible} {...(sidebarVisible ? {} : { inert: "" })}>
        {sidebar}
      </aside>

      {!IS_MACOS && <MacWindowControls />}

      <div className={styles.column}>
        <header className={styles.toolbar} data-tauri-drag-region>
          <button
            type="button"
            className={styles.glassButton}
            aria-label={toggleLabel}
            title={`${toggleLabel} · ⌃⌘S`}
            aria-pressed={sidebarVisible}
            onClick={onToggleSidebar}
          >
            <RedesignIcon name="sidebar" className={styles.glassIcon} />
          </button>
          <h1 className={styles.title} data-tauri-drag-region>
            {title}
          </h1>
          <div className={styles.spacer} data-tauri-drag-region />
          {toolbarActions}
        </header>

        <main className={styles.main}>{children}</main>
      </div>
    </div>
  );
}
