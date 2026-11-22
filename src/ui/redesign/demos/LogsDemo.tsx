import { Badge, Collapse, Stage, type Act } from "./kit";
import "./demos.css";

// Логи: шаги одной задачи приходят сверху вниз, последний подводит итог.

type S = { shown: number };

const LINES: { time: string; text: string; done?: boolean }[] = [
  { time: "14:02:11", text: "Загрузка: 1080p60, 2,4 ГБ" },
  { time: "14:09:37", text: "Рендер чата наложен на видео" },
  { time: "14:12:05", text: "Блюр: 2 зоны" },
  { time: "14:13:48", text: "Файл сохранён", done: true },
];
const initial: S = { shown: 0 };
const poster: S = { shown: 4 };

async function script(a: Act<S>) {
  await a.wait(500);
  for (let shown = 1; shown <= LINES.length; shown++) {
    a.put({ shown });
    await a.wait(800);
  }
  await a.wait(2000);
  await a.set({ shown: 0 });
  await a.wait(500);
}

export default function LogsDemo() {
  return (
    <Stage<S> width={560} height={196} theme="dark" initial={initial} poster={poster} script={script} className="fd fd--whole">
      {(s) => (
        <div className="fd-panel fd-panel--log">
          {LINES.map((line, i) => (
            <Collapse key={line.time} open={s.shown > i} reveal="drop">
              <div className="fd-log">
                <span className="fd-log__time">{line.time}</span>
                <span className="fd-title">{line.text}</span>
                {line.done && <Badge tone="success">Готово</Badge>}
              </div>
            </Collapse>
          ))}
        </div>
      )}
    </Stage>
  );
}
