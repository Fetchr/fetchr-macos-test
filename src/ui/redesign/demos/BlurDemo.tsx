import { Badge, Collapse, Stage, type Act, type Point } from "./kit";
import "./demos.css";

// Блюр спонсоров: зона обводится прямо по логотипу на кадре и сразу размывает его.

type S = { x: number; y: number; w: number; h: number; on: boolean; listed: boolean };

const initial: S = { x: 0, y: 0, w: 0, h: 0, on: false, listed: false };
const poster: S = { x: 28, y: 26, w: 152, h: 62, on: true, listed: true };

async function script(a: Act<S>) {
  await a.wait(600);
  const frame = a.rect("frame");
  const logo = a.rect("logo");
  const local = (p: Point) => ({ x: p.x - frame.x, y: p.y - frame.y });
  const start = { x: logo.x - frame.x - 8, y: logo.y - frame.y - 8 };
  a.mark("draw");
  await a.move({ x: logo.x - 8, y: logo.y - 8 });
  a.put({ x: start.x, y: start.y, w: 0, h: 0, on: true });
  await a.drag({ x: logo.x + logo.width + 8, y: logo.y + logo.height + 8 }, (at) => {
    const p = local(at);
    a.put({ w: Math.max(0, p.x - start.x), h: Math.max(0, p.y - start.y) });
  });
  a.mark("listed");
  a.put({ listed: true });
  await a.wait(2300);
  a.put({ on: false, listed: false });
  await a.wait(560);
  await a.snap({ x: 0, y: 0, w: 0, h: 0 });
}

export default function BlurDemo() {
  return (
    <Stage<S> width={560} height={268} theme="dark" initial={initial} poster={poster} script={script} className="fd fd--whole" cursor={{ at: { x: 500, y: 236 } }}>
      {(s) => (
        <div className="fd-panel fd-split">
          <div className="fd-frame" data-target="frame" data-cursor="crosshair">
            <span className="fd-logo" data-target="logo">SPONSOR</span>
            <span className="fd-zone" data-on={s.on || undefined} style={{ left: s.x, top: s.y, width: s.w, height: s.h }} />
          </div>
          <div className="fd-side">
            <span className="fd-meta">Зоны</span>
            <Collapse open={s.listed} reveal="drop">
              <div className="fd-zone-row">
                <span className="fd-title">Логотип</span>
                <Badge tone="accent">Блюр</Badge>
              </div>
            </Collapse>
          </div>
        </div>
      )}
    </Stage>
  );
}
