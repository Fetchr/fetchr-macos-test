import type { ReactNode } from "react";

import fetchrLogo from "@/assets/fetchr-logo.png";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";
import topbar from "@/ui/redesign/topbar/TopAppBar.module.css";

import { NAV } from "../content";
import "./AppWindow.css";

/**
 * Окно Fetchr. Топбар собран на настоящем CSS-модуле TopAppBar: цвета,
 * отступы и пилюли вкладок совпадают с приложением один в один. Разметка
 * своя — без сторов и Tauri, только то, что видно в кадре.
 */
export function AppWindow({ children }: { children: ReactNode }) {
  return (
    <div className="win" data-p="win">
      <div className={topbar.topBar}>
        <div className={topbar.titleRow}>
          <div className={topbar.brandGroup}>
            <div className={topbar.brandMark}>
              <img className={topbar.brandImage} src={fetchrLogo} alt="" />
            </div>
            <div className={topbar.brandText}>
              <span className={topbar.brandName}>Fetchr</span>
              <span className={topbar.version}>{__APP_VERSION__}</span>
            </div>
          </div>
          <div className={topbar.actions}>
            <div className={`${topbar.statusWidget} ${topbar.statusWidgetActive} winStatus`} data-p="win.status">
              <span className={topbar.statusWidgetDot} />
              <span className={topbar.statusWidgetItem}>
                <RedesignIcon name="download" size={14} />
                <span className={`${topbar.statusWidgetCount} winStatusCount`} data-p="win.status.count">
                  0 MB/s
                </span>
              </span>
            </div>
            <span className={topbar.iconButton}>
              <RedesignIcon name="finder" size={16} />
            </span>
            <span className={topbar.iconButton}>
              <RedesignIcon name="settings" size={16} />
            </span>
            <div className={topbar.windowDivider} />
            <div className={topbar.windowControls}>
              <span className={topbar.windowButton}>
                <RedesignIcon name="minimize" size={16} />
              </span>
              <span className={topbar.windowButton}>
                <RedesignIcon name="stop" size={13} />
              </span>
              <span className={topbar.windowButton}>
                <RedesignIcon name="close" size={16} />
              </span>
            </div>
          </div>
        </div>
        <div className={topbar.workspaceRow}>
          <div className={topbar.workspaceNavigation}>
            <span className={topbar.homeButton}>
              <RedesignIcon name="home" size={16} />
            </span>
            <div className={topbar.workspaceDivider} />
            <nav className={`${topbar.navTabs} winNav`}>
              <span className="winNavPill" data-p="nav.pill" />
              {NAV.map((item) => (
                <div className={topbar.navItemWithMenu} key={item.id}>
                  <span className={topbar.navTab} data-p={`nav.${item.id}`}>
                    <RedesignIcon name={item.icon as RedesignIconName} className={topbar.navTabIcon} />
                    <span data-p={`nav.${item.id}.label`}>{item.label}</span>
                    {item.id === "queue" && (
                      <span className={`${topbar.navTabBadge} winBadge`} data-p="nav.queue.badge">
                        4
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </nav>
          </div>
        </div>
      </div>
      <div className="winContent" data-p="win.content">
        {children}
      </div>
      {/* Задача, улетающая в очередь: живёт над видами, чтобы долететь до вкладки */}
      <div className="winFly" data-p="fly">
        <RedesignIcon name="download" size={14} />
        <span data-p="fly.label">Реакция на трейлеры</span>
      </div>
      <Cursor />
    </div>
  );
}

/** Курсор Windows: живёт в координатах окна и двигается вместе с ним */
function Cursor() {
  return (
    <div className="cur" data-p="cursor">
      <span className="curRipple" data-p="cursor.ripple" />
      <svg className="curArrow" data-p="cursor.arrow" width="26" height="30" viewBox="0 0 26 30" aria-hidden="true">
        <path
          d="M2.2 1.6v22.6l6-5.6 4.3 9.6 4-1.8-4.2-9.4h8.3L2.2 1.6Z"
          fill="#fff"
          stroke="#0b0c0e"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
