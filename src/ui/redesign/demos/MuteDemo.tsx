import { Badge, Check, Count, Stage, States, type Act } from "./kit";
import "./demos.css";

// Удаление матов: дорожка размечается по ходу распознавания, найденное слово
// закрывается прямо в расшифровке, счётчик растёт на том же месте.

type S = { at: number; hits: number; done: boolean };

const BARS = Array.from({ length: 56 }, (_, i) => 22 + Math.abs(Math.sin(i * 0.61) * 52 + Math.sin(i * 0.19) * 22));
const HITS = [14, 31, 46];
const initial: S = { at: 0, hits: 0, done: false };
const poster: S = { at: 100, hits: 3, done: true };

async function script(a: Act<S>) {
  await a.wait(600);
  a.mark("scan");
  for (let at = 4; at <= 100; at += 4) {
    const bar = (at / 100) * BARS.length;
    a.put({ at, hits: HITS.filter((hit) => hit < bar).length });
    await a.wait(170);
  }
  a.mark("done");
  a.put({ done: true });
  await a.wait(2200);
  await a.set({ done: false });
  await a.snap({ at: 0, hits: 0 });
}

export default function MuteDemo() {
  return (
    <Stage<S> width={560} height={216} theme="dark" initial={initial} poster={poster} script={script} className="fd fd--whole">
      {(s) => (
        <div className="fd-panel">
          <div className="fd-clip-bar">
            <span className="fd-title">Стрим от 3 ноября.mp4</span>
            <States
              align="end"
              value={s.done ? "done" : "scan"}
              states={{
                scan: <span className="fd-meta">Распознаём речь</span>,
                done: <Badge tone="success" icon={<Check on size={12} />}>Заглушено</Badge>,
              }}
            />
          </div>
          <div className="fd-waves fd-waves--scan" data-on="">
            {BARS.map((h, i) => {
              const seen = (i / BARS.length) * 100 < s.at;
              return <i key={i} data-seen={seen || undefined} data-hit={(seen && HITS.includes(i)) || undefined} style={{ height: `${h}%` }} />;
            })}
          </div>
          <div className="fd-clip-bar">
            <span className="fd-quote">
              ну это просто <mark data-on={s.hits > 0 || undefined}>полный кошмар</mark> какой-то
            </span>
            <span className="fd-meta">
              Найдено: <Count value={s.hits} />
            </span>
          </div>
        </div>
      )}
    </Stage>
  );
}
