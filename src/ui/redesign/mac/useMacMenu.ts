import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

import { IS_MACOS } from "@/lib/platform";

/** Совпадает с mac_menu::MENU_EVENT в src-tauri. */
const MENU_EVENT = "mac-menu";
const NAV_PREFIX = "nav:";

export interface MacMenuHandlers {
  navigate: (section: string) => void;
  openSettings: () => void;
  addLink: () => void;
  openPalette: () => void;
  startQueue: () => void;
  toggleSidebar: () => void;
  openWhatsNew: () => void;
  openHelpSite: () => void;
  openTour: () => void;
}

export function routeMenuItem(id: string, handlers: MacMenuHandlers): boolean {
  if (id.startsWith(NAV_PREFIX)) {
    const section = id.slice(NAV_PREFIX.length);
    if (!section) return false;
    handlers.navigate(section);
    return true;
  }
  const actions: Record<string, (() => void) | undefined> = {
    settings: handlers.openSettings,
    add: handlers.addLink,
    palette: handlers.openPalette,
    "start-queue": handlers.startQueue,
    "toggle-sidebar": handlers.toggleSidebar,
    "whats-new": handlers.openWhatsNew,
    "help-site": handlers.openHelpSite,
    "help-tour": handlers.openTour,
  };
  const action = actions[id];
  if (!action) return false;
  action();
  return true;
}

/** Пункты нативного меню macOS приходят из Rust событием с id пункта. */
export function useMacMenu(handlers: MacMenuHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (!IS_MACOS) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<string>(MENU_EVENT, (event) => {
      if (typeof event.payload === "string") routeMenuItem(event.payload, latest.current);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => {
        console.warn("macOS menu events unavailable:", error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
