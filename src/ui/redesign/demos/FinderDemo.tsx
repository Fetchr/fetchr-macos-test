import { Badge, Collapse, Field, Stage, type Act } from "./kit";
import "./demos.css";

// M3U8 Finder: канал вставлен, найденные записи по одной открываются в списке.

type S = { url: string; focused: boolean; shown: number };

const ROWS = [
  { title: "Запись от 2 ноября", meta: "6 ч 12 мин", quality: "1080p60" },
  { title: "Запись от 31 октября", meta: "4 ч 40 мин", quality: "1080p60" },
  { title: "Запись от 29 октября", meta: "5 ч 03 мин", quality: "720p" },
];
const initial: S = { url: "", focused: false, shown: 0 };
const poster: S = { url: "aurora_live", focused: false, shown: 3 };

async function script(a: Act<S>) {
  await a.wait(600);
  await a.click("url");
  a.put({ focused: true });
  await a.type("url", "aurora_live", { interval: 55 });
  await a.wait(220);
  await a.click("find");
  a.put({ focused: false });
  for (let shown = 1; shown <= ROWS.length; shown++) {
    await a.wait(480);
    a.put({ shown });
  }
  await a.wait(2300);
  a.put({ shown: 0 });
  await a.wait(560);
  a.put({ url: "" });
}

export default function FinderDemo() {
  return (
    <Stage<S> width={560} height={252} theme="dark" initial={initial} poster={poster} script={script} className="fd fd--whole" cursor={{ at: { x: 500, y: 226 } }}>
      {(s) => (
        <div className="fd-panel">
          <div className="fd-bar">
            <Field value={s.url} placeholder="Канал или ссылка на VOD" focused={s.focused} box={{ "data-target": "url", "data-cursor": "ibeam" }} />
            <span className="fd-btn" data-target="find" data-cursor="pointer">Найти</span>
          </div>
          <div className="fd-list">
            {ROWS.map((row, i) => (
              <Collapse key={row.title} open={s.shown > i} reveal="drop">
                <div className="fd-row">
                  <span className="fd-thumb" />
                  <span className="fd-lines">
                    <span className="fd-title">{row.title}</span>
                    <span className="fd-meta">{row.meta}</span>
                  </span>
                  <span className="fd-end fd-end--right">
                    <Badge tone={i === 0 ? "accent" : "neutral"}>{row.quality}</Badge>
                  </span>
                </div>
              </Collapse>
            ))}
          </div>
        </div>
      )}
    </Stage>
  );
}
