import { useLayoutEffect, useRef } from "react";

import { AppWindow } from "./components/AppWindow";
import { Captions } from "./components/Captions";
import { GapWords, ShotWall, Stats } from "./components/Finale";
import { Flash, OpeningWords, StreamWall } from "./components/Opening";
import { PowerCards } from "./components/PowerCards";
import { Backdrop, Hero, Outro, PowerTitle } from "./components/Scenery";
import { BlurTakeover, ChatTakeover } from "./components/Takeovers";
import { allCues, runFrameHooks } from "./lib/motion";
import { buildMaster, FPS } from "./timeline/master";
import { ChatView } from "./views/ChatView";
import { BlurView } from "./views/BlurView";
import { FinderView } from "./views/FinderView";
import { LiveView } from "./views/LiveView";
import { MuteView } from "./views/MuteView";
import { QueueView } from "./views/QueueView";
import { VocalView } from "./views/VocalView";
import { VpsView } from "./views/VpsView";
import { WorkspaceView } from "./views/WorkspaceView";

declare global {
  interface Window {
    __promo?: {
      ready: boolean;
      fps: number;
      duration: number;
      seek: (time: number) => void;
      cues: ReturnType<typeof allCues>;
    };
  }
}

async function loadFonts() {
  await Promise.all([
    document.fonts.load('400 24px "Inter Variable"'),
    document.fonts.load('600 64px "Inter Variable"'),
    document.fonts.load('500 16px "JetBrains Mono Variable"'),
  ]);
  await document.fonts.ready;
}

/** Предпросмотр в обычной вкладке: сцена ужимается под окно */
function fitToWindow(stage: HTMLElement) {
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  stage.dataset.fit = "";
  stage.style.transform = `scale(${scale}) translate(-50%, -50%)`;
}

export function Promo() {
  const stageRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let alive = true;

    void loadFonts().then(() => {
      if (!alive) return;
      const master = buildMaster(stage);
      const seek = (time: number) => {
        master.seek(time, false);
        runFrameHooks(time);
      };
      window.__promo = { ready: true, fps: FPS, duration: master.duration(), seek, cues: allCues() };

      const params = new URLSearchParams(window.location.search);
      if (params.has("fit")) fitToWindow(stage);
      seek(Number(params.get("t") ?? 0));
    });

    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="stage" ref={stageRef}>
      <Backdrop />
      <StreamWall />
      <ShotWall />
      <Hero />
      <PowerTitle />
      <PowerCards />
      <div className="rig" data-p="rig">
        <AppWindow>
          <QueueView />
          <LiveView />
          <VpsView />
          <FinderView />
          <ChatView />
          <BlurView />
          <MuteView />
          <VocalView />
          <WorkspaceView />
        </AppWindow>
      </div>
      <BlurTakeover />
      <ChatTakeover />
      <OpeningWords />
      <Captions />
      <Stats />
      <GapWords />
      <Outro />
      <Flash />
      <div className="layer fade" data-p="fade" />
    </div>
  );
}
