import { Avatar, Badge, Count, Spinner, Stage, States, type Act } from "./kit";
import "./demos.css";

// Запись эфира: канал ещё офлайн, запись ждёт; эфир начался сам, без клика,
// и таймер пошёл. Статус меняется на одном и том же месте.

type S = { live: boolean; seconds: number; hidden: boolean };

const WAVE = [38, 62, 44, 80, 56, 30, 72, 90, 48, 66, 34, 58, 84, 42, 70, 52, 28, 64, 88, 46, 60, 36, 76, 50, 68, 40, 82, 54];
const initial: S = { live: false, seconds: 0, hidden: false };
const poster: S = { live: true, seconds: 14, hidden: false };

const clock = (n: number) => `00:00:${String(n).padStart(2, "0")}`;

async function script(a: Act<S>) {
  await a.wait(2200);
  a.mark("live");
  a.put({ live: true });
  for (let seconds = 1; seconds <= 6; seconds++) {
    await a.wait(1000);
    a.put({ seconds });
  }
  await a.wait(1400);
  a.put({ live: false, hidden: true });
  await a.wait(360);
  await a.snap({ seconds: 0 });
  a.put({ hidden: false });
}

export default function LiveDemo() {
  return (
    <Stage<S> width={560} height={190} theme="dark" initial={initial} poster={poster} script={script} className="fd fd--whole">
      {(s) => (
        <div className="fd-panel">
          <div className="fd-channel">
            <Avatar name="Аврора" size={36} tone="accent" />
            <span className="fd-lines">
              <span className="fd-title">aurora_live</span>
              <span className="fd-meta">twitch.tv/aurora_live</span>
            </span>
            <States
              align="end"
              value={s.live ? "live" : "wait"}
              states={{
                wait: <Badge tone="neutral" icon={<Spinner size={10} />}>Ждём эфир</Badge>,
                live: <Badge tone="danger" icon={<i className="fd-live-dot" />}>Идёт запись</Badge>,
              }}
            />
          </div>
          <span className="fd-clock" data-hidden={s.hidden || undefined}>
            <Count value={s.seconds} format={clock} />
          </span>
          <div className="fd-waves" data-on={s.live || undefined}>
            {WAVE.map((h, i) => (
              <i key={i} style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>
      )}
    </Stage>
  );
}
