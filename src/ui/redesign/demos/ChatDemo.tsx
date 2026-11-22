import { Collapse, Count, Meter, Stage, type Act } from "./kit";
import "./demos.css";

// Рендер чата: сообщения идут поверх кадра в том виде, в каком лягут на видео.

type S = { shown: number; pct: number };

const MESSAGES = [
  { nick: "kotik_tv", color: "#a78bfa", text: "вот это момент" },
  { nick: "sasha404", color: "#5ec8ff", text: "клипайте скорее" },
  { nick: "lena_on", color: "#2fd49b", text: "ахаха, повтор!" },
  { nick: "maxgg", color: "#f2a93b", text: "лучший стрим недели" },
];
const initial: S = { shown: 0, pct: 0 };
const poster: S = { shown: 4, pct: 100 };

async function script(a: Act<S>) {
  await a.wait(500);
  for (let shown = 1; shown <= MESSAGES.length; shown++) {
    a.put({ shown, pct: shown * 25 });
    await a.wait(900);
  }
  await a.wait(1900);
  a.put({ shown: 0 });
  await a.wait(600);
  await a.snap({ pct: 0 });
}

export default function ChatDemo() {
  return (
    <Stage<S> width={560} height={268} theme="dark" initial={initial} poster={poster} script={script} className="fd fd--whole">
      {(s) => (
        <div className="fd-panel">
          <div className="fd-frame fd-frame--wide">
            <div className="fd-chat">
              {MESSAGES.map((m, i) => (
                <Collapse key={m.nick} open={s.shown > i} reveal="drop" from="below">
                  <div className="fd-chat__line">
                    <b style={{ color: m.color }}>{m.nick}:</b> {m.text}
                  </div>
                </Collapse>
              ))}
            </div>
          </div>
          <div className="fd-clip-bar">
            <Meter value={s.pct / 100} style={{ flex: 1 }} />
            <span className="fd-meta"><Count value={s.pct} format={(n) => `${n}%`} /></span>
          </div>
        </div>
      )}
    </Stage>
  );
}
