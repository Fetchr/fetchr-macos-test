import { BANNER, PROBLEMS, STREAMS, VERBS } from "../content";
import { StreamFrame } from "./StreamFrame";
import "./Opening.css";

type Tile = { kind: "image"; src: string; fit?: "contain" } | { kind: "frame"; palette: "dusk" | "arctic" | "ember" | "forest" | "violet"; seed: number };

/**
 * Стена стримов: двенадцать экранов в 3D. Пять — настоящие стримы из папки
 * «Промо», один — рекламный баннер, остальные — процедурные кадры.
 * Порядок подобран так, чтобы соседние экраны не повторяли цвет.
 */
export const WALL: Tile[] = [
  { kind: "frame", palette: "dusk", seed: 3 },
  { kind: "image", src: STREAMS.geo.thumb },
  { kind: "frame", palette: "arctic", seed: 12 },
  { kind: "image", src: STREAMS.rostik.thumb },
  { kind: "image", src: STREAMS.xqc.thumb },
  { kind: "frame", palette: "ember", seed: 21 },
  { kind: "image", src: BANNER, fit: "contain" },
  { kind: "image", src: STREAMS.hls.thumb },
  { kind: "frame", palette: "violet", seed: 57 },
  { kind: "image", src: STREAMS.leva.thumb },
  { kind: "frame", palette: "forest", seed: 44 },
  { kind: "frame", palette: "dusk", seed: 31 },
];

/** Какой экран вспыхивает под каждым глаголом: «Скачать» — YouTube, «Записать» — Dota и т. д. */
export const VERB_TILES = [1, 3, 7, 4, 6, 9, 5] as const;

export function StreamWall() {
  return (
    <div className="layer sw" data-p="sw">
      <div className="swPlane" data-p="sw.plane">
        {WALL.map((tile, index) => (
          <div className="swTile" data-p="sw.tile" key={index}>
            {tile.kind === "image" ? (
              <img className={`swImg${tile.fit === "contain" ? " swImgContain" : ""}`} src={tile.src} alt="" />
            ) : (
              <StreamFrame palette={tile.palette} seed={tile.seed} className="swImg" />
            )}
            <span className="swGlow" data-p="sw.glow" />
          </div>
        ))}
      </div>
      <div className="swShade" data-p="sw.shade" />
    </div>
  );
}

/** Крупные слова вступления: сначала боль, потом глаголы по долям */
export function OpeningWords() {
  return (
    <div className="layer ow" data-p="ow">
      {PROBLEMS.map((line) => (
        <div className="owProblem" data-p="ow.problem" key={line}>
          {line}
        </div>
      ))}
      {VERBS.map((word) => (
        <div className="owVerb gradText" data-p="ow.verb" key={word}>
          {word}
        </div>
      ))}
    </div>
  );
}

/** Белая вспышка на сильных долях и склейках */
export function Flash() {
  return <div className="layer flash" data-p="flash" />;
}
