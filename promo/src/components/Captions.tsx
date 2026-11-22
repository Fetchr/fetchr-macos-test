import { CAPTIONS, type CaptionId } from "../content";
import "./Captions.css";

/** Где стоит подпись: сбоку от окна, над ним или поверх полноэкранного кадра */
const PLACEMENT: Record<CaptionId, "left" | "right" | "top" | "bottom"> = {
  queue: "left",
  threads: "right",
  finder: "left",
  live: "right",
  vps: "left",
  plans: "top",
  blur: "bottom",
  chat: "bottom",
  mute: "top",
  vocal: "top",
  workspace: "left",
};

/** Подписи сцен: надзаголовок и две строки, въезжают из-под маски */
export function Captions() {
  return (
    <div className="layer cap" data-p="cap">
      <div className="capShade capShadeBottom" data-p="cap.shade.bottom" />
      <div className="capShade capShadeTop" data-p="cap.shade.top" />
      {(Object.keys(CAPTIONS) as CaptionId[]).map((id) => (
        <section className={`capBlock cap-${PLACEMENT[id]}`} key={id}>
          <div className="capEyebrow mono">
            <span className="lineMask">
              <span data-p={`cap.${id}.line`}>{CAPTIONS[id].eyebrow}</span>
            </span>
          </div>
          <h2 className="capTitle">
            {CAPTIONS[id].title.map((line) => (
              <span className="lineMask" key={line}>
                <span className="gradText" data-p={`cap.${id}.line`}>
                  {line}
                </span>
              </span>
            ))}
          </h2>
        </section>
      ))}
    </div>
  );
}
