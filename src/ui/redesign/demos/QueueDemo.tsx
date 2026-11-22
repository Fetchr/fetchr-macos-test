import { Badge, Bar, Check, Collapse, Count, Field, Meter, Stage, States, type Act } from "./kit";
import "./demos.css";

// Пустая очередь: ссылка вставлена, задача открывается сверху списка,
// процент докручивается до конца, статус меняется на том же месте.

type S = { url: string; focused: boolean; open: boolean; pct: number; done: boolean };

const LINK = "twitch.tv/videos/2281904417";
const initial: S = { url: "", focused: false, open: false, pct: 0, done: false };
const poster: S = { url: "", focused: false, open: true, pct: 100, done: true };

async function script(a: Act<S>) {
  await a.wait(700);
  a.mark("paste");
  await a.click("url");
  a.put({ focused: true });
  await a.type("url", LINK, { interval: 28 });
  await a.wait(240);
  await a.click("start");
  a.mark("download");
  a.put({ url: "", focused: false, open: true });
  for (const pct of [12, 31, 47, 68, 84]) {
    await a.wait(520);
    a.put({ pct });
  }
  await a.wait(520);
  a.mark("done");
  a.put({ pct: 100, done: true });
  await a.wait(2200);
  a.put({ open: false });
  await a.wait(600);
  await a.snap({ pct: 0, done: false });
}

export default function QueueDemo() {
  return (
    <Stage<S>
      width={560}
      height={276}
      theme="dark"
      initial={initial}
      poster={poster}
      script={script}
      className="fd"
      cursor={{ at: { x: 500, y: 240 } }}
    >
      {(s) => (
        <div className="fd-panel">
          <div className="fd-bar">
            <Field value={s.url} placeholder="Ссылка на запись или канал" focused={s.focused} box={{ "data-target": "url", "data-cursor": "ibeam" }} />
            <span className="fd-btn" data-target="start" data-cursor="pointer">Скачать</span>
          </div>
          <div className="fd-list">
            <Collapse open={s.open} reveal="drop">
              <div className="fd-row">
                <span className="fd-thumb" />
                <span className="fd-lines">
                  <span className="fd-title">Финал сезона, полная запись</span>
                  <Meter value={s.pct / 100} tone={s.done ? "success" : "accent"} />
                </span>
                <span className="fd-end">
                  <States
                    align="end"
                    value={s.done ? "done" : "busy"}
                    states={{
                      busy: <span className="fd-meta"><Count value={s.pct} format={(n) => `${n}%`} /></span>,
                      done: <Badge tone="success" icon={<Check on size={12} />}>Готово</Badge>,
                    }}
                  />
                </span>
              </div>
            </Collapse>
            {[188, 150, 210].map((w) => (
              <div key={w}>
                <div className="fd-row">
                  <span className="fd-thumb" data-quiet="" />
                  <span className="fd-lines">
                    <Bar w={w} h={8} r={4} tone={2} />
                    <Bar w={96} h={6} r={3} tone={1} />
                  </span>
                  <span className="fd-end" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Stage>
  );
}
