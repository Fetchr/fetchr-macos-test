import { useState } from "react";


import { BlurDemo, ChatDemo, ClipDemo, DemoSlot, LiveDemo, MuteDemo, QueueDemo, VocalDemo } from "@/ui/redesign/demos/DemoSlot";

import type { UpdateCategory } from "./updatePages";
import a from "./UpdateArt.module.css";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/**
 * Верх страницы «Что нового»: картинка или GIF из манифеста, иначе
 * анимированная миниатюра настоящего экрана этого раздела.
 */
export function UpdateArt({ category, media }: { category: UpdateCategory; media: string | null }) {
  const [failed, setFailed] = useState(false);
  if (media && !failed) {
    const video = /\.(mp4|webm)(\?|$)/i.test(media);
    return (
      <div className={a.art} data-cat={category}>
        {video ? (
          <video className={a.media} src={media} autoPlay loop muted playsInline onError={() => setFailed(true)} />
        ) : (
          <img className={a.media} src={media} alt="" onError={() => setFailed(true)} />
        )}
      </div>
    );
  }
  const demo = DEMOS[category];
  if (demo) {
    return (
      <div className={a.art} data-cat={category} aria-hidden="true">
        <DemoSlot demo={demo.component} height={demo.height} />
      </div>
    );
  }
  return (
    <div className={a.art} data-cat={category} aria-hidden="true">
      <span className={a.glow} />
      <div className={a.window}>
        <div className={a.titlebar}>
          <i />
          <i />
          <i />
          <span>Fetchr</span>
        </div>
        <div className={a.body}>
          <nav className={a.rail}>
            {range(7).map((i) => (
              <i key={i} />
            ))}
          </nav>
          <div className={a.content}><GeneralScene /></div>
        </div>
      </div>
    </div>
  );
}

const DEMOS: Partial<Record<UpdateCategory, { component: typeof QueueDemo; height: number }>> = {
  download: { component: QueueDemo, height: 276 },
  queue: { component: QueueDemo, height: 276 },
  live: { component: LiveDemo, height: 190 },
  archive: { component: ClipDemo, height: 268 },
  chat: { component: ChatDemo, height: 268 },
  blur: { component: BlurDemo, height: 268 },
  mute: { component: MuteDemo, height: 216 },
  vocal: { component: VocalDemo, height: 232 },
};

const GeneralScene = () => (
    <div className={a.compare}>
      <div className={a.oldUi}>
        {range(4).map((i) => (
          <i key={i} />
        ))}
      </div>
      <div className={a.newUi}>
        <span className={a.newBar} />
        {range(3).map((i) => (
          <span key={i} className={a.newRow}>
            <b />
            <em />
          </span>
        ))}
      </div>
      <span className={a.switchPill}>
        <span>Старый</span>
        <span>Новый</span>
        <i />
      </span>
    </div>
);
