import { GAP_WORDS, ONE_WINDOW, STATS } from "../content";
import "./Finale.css";

/** Сколько экранов на стене второго дропа: 4 × 3 */
export const SHOT_COUNT = 12;

/** Пауза перед дропом: «Всё это —» на удары бочки */
export function GapWords() {
  return (
    <div className="layer gw" data-p="gw">
      <div className="gwLine">
        {GAP_WORDS.map((word) => (
          <span className="gwWord gradText" data-p="gw.word" key={word}>
            {word}
          </span>
        ))}
      </div>
      <div className="gwOne accentText" data-p="gw.one">
        {ONE_WINDOW}
      </div>
    </div>
  );
}

/**
 * Стена второго дропа. Слоты пустые: при сборке таймлайна в них кладутся
 * копии живого окна и полноэкранных сцен в нужные моменты — стена
 * показывает ровно тот интерфейс, что зритель видел минуту назад.
 */
export function ShotWall() {
  return (
    <div className="layer sh" data-p="sh">
      <div className="shPlane" data-p="sh.plane">
        {Array.from({ length: SHOT_COUNT }, (_, index) => (
          <div className="shTile" data-p="sh.tile" key={index}>
            <div className="shSlot" data-p="sh.slot" />
            <span className="shGlow" data-p="sh.glow" />
          </div>
        ))}
      </div>
      <div className="shShade" data-p="sh.shade" />
    </div>
  );
}

export function Stats() {
  return (
    <div className="layer st" data-p="st">
      {STATS.map((stat) => (
        <div className="stItem" data-p="st.item" key={stat.value}>
          <div className="stValue gradText">{stat.value}</div>
          <div className="stLabel">{stat.label}</div>
        </div>
      ))}
    </div>
  );
}
