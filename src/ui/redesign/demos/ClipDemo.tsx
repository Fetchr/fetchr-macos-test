import { Badge, Bar, Check, Collapse, Spinner, Stage, States, type Act } from "./kit";
import "./demos.css";

// Архив VPS: отрезок выделен на записи, клип собирается на сервере и
// приходит на компьютер готовым файлом.

type S = { from: number; to: number; selecting: boolean; state: "idle" | "busy"; open: boolean };

const FRAMES = 14;
const initial: S = { from: 0, to: 0, selecting: false, state: "idle", open: false };
const poster: S = { from: 150, to: 330, selecting: true, state: "idle", open: true };

async function script(a: Act<S>) {
  await a.wait(600);
  const track = a.rect("track");
  a.mark("select");
  await a.move({ at: "track", x: 0.3, y: 0.5 });
  const start = a.center("track").x - track.width / 2;
  const left = track.width * 0.3;
  await a.drag({ at: "track", x: 0.66, y: 0.5 }, (at) => {
    a.put({ selecting: true, from: left, to: Math.max(left, at.x - start) });
  });
  await a.wait(260);
  await a.click("cut");
  a.mark("cut");
  a.put({ state: "busy" });
  await a.wait(1500);
  a.mark("clip");
  a.put({ state: "idle", open: true });
  await a.wait(2300);
  a.put({ open: false, selecting: false });
  await a.wait(600);
  await a.snap({ from: 0, to: 0 });
}

export default function ClipDemo() {
  return (
    <Stage<S>
      width={560}
      height={268}
      theme="dark"
      initial={initial}
      poster={poster}
      script={script}
      className="fd"
      cursor={{ at: { x: 500, y: 236 } }}
    >
      {(s) => (
        <div className="fd-panel">
          <div className="fd-track" data-target="track" data-cursor="crosshair">
            {Array.from({ length: FRAMES }, (_, i) => (
              <i key={i} />
            ))}
            <span className="fd-select" data-on={s.selecting || undefined} style={{ left: s.from, width: Math.max(0, s.to - s.from) }} />
          </div>
          <div className="fd-clip-bar">
            <span className="fd-meta">{s.selecting ? "Отрезок выделен" : "Выделите отрезок"}</span>
            <span className="fd-btn" data-target="cut" data-cursor="pointer" data-busy={s.state === "busy" || undefined}>
              <States
                value={s.state}
                states={{
                  idle: "Вырезать на сервере",
                  busy: (
                    <span className="fd-busy">
                      <Spinner size={12} />
                      Собираем клип
                    </span>
                  ),
                }}
              />
            </span>
          </div>
          <div className="fd-list">
            <Collapse open={s.open} reveal="drop">
              <div className="fd-row">
                <span className="fd-thumb" />
                <span className="fd-lines">
                  <span className="fd-title">Лучший момент</span>
                  <span className="fd-meta">00:42 · 86 МБ</span>
                </span>
                <span className="fd-end">
                  <Badge tone="success" icon={<Check on size={12} />}>На компьютере</Badge>
                </span>
              </div>
            </Collapse>
            <div>
              <div className="fd-row">
                <span className="fd-thumb" data-quiet="" />
                <span className="fd-lines">
                  <Bar w={170} h={8} r={4} tone={2} />
                  <Bar w={84} h={6} r={3} tone={1} />
                </span>
                <span className="fd-end" />
              </div>
            </div>
          </div>
        </div>
      )}
    </Stage>
  );
}
