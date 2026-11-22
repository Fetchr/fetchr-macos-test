import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { NavPosition } from "@/stores/settings";
import { fetchrThemeClassName } from "@/ui/redesign/theme";

import { NavRow, type NavRowProps } from "./NavRow";
import styles from "./NavDock.module.css";

interface NavDockFrameProps {
  position: NavPosition;
  navProps: Omit<NavRowProps, "orientation">;
  children: ReactNode;
}

/**
 * Рамка вокруг страницы. Сверху панель живёт в TopAppBar, поэтому здесь она
 * не рисуется; у остальных краёв панель стоит рядом со страницей и не
 * зависит от сеток FetchrAppShell, которые прячут боковые слоты на узких окнах.
 */
export function NavDockFrame({ position, navProps, children }: NavDockFrameProps) {
  if (position === "top") return <>{children}</>;
  const vertical = position === "left" || position === "right";

  return (
    <div className={cn(fetchrThemeClassName, styles.frame)} data-dock={position}>
      <div className={styles.dock}>
        <NavRow {...navProps} orientation={vertical ? "vertical" : "horizontal"} dock={position} />
      </div>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
