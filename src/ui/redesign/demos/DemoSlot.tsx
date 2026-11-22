import { lazy, Suspense, type LazyExoticComponent, type ComponentType } from "react";

import { cn } from "@/lib/utils";

import "./demos.css";

export const QueueDemo = lazy(() => import("./QueueDemo"));
export const LiveDemo = lazy(() => import("./LiveDemo"));
export const ClipDemo = lazy(() => import("./ClipDemo"));
export const MuteDemo = lazy(() => import("./MuteDemo"));
export const VocalDemo = lazy(() => import("./VocalDemo"));
export const BlurDemo = lazy(() => import("./BlurDemo"));
export const ChatDemo = lazy(() => import("./ChatDemo"));
export const FinderDemo = lazy(() => import("./FinderDemo"));
export const LogsDemo = lazy(() => import("./LogsDemo"));

/** Кит подгружается отдельным чанком; слот держит высоту, чтобы текст под ним не прыгал. */
export function DemoSlot({ demo: Demo, height, className }: { demo: LazyExoticComponent<ComponentType>; height: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("fd-slot", className)} style={{ aspectRatio: `560 / ${height}` }}>
      <Suspense fallback={null}>
        <Demo />
      </Suspense>
    </div>
  );
}
