import { Badge, Check, Collapse, Meter, Stage, States, type Act } from "./kit";
import "./demos.css";

// Vocal Remover: одна дорожка превращается в две, общая остаётся сверху как исходник.

type S = { pct: number; split: boolean };

const wave = (seed: number, n = 44) => Array.from({ length: n }, (_, i) => 18 + Math.abs(Math.sin(i * seed) * 58 + Math.sin(i * seed * 0.3) * 22));
const MIX = wave(0.47);
const VOICE = wave(0.83);
const MUSIC = wave(0.29);
const initial: S = { pct: 0, split: false };
const poster: S = { pct: 100, split: true };

function Track({ name, bars, tone }: { name: string; bars: number[]; tone?: string }) {
  return (
    <div className="fd-stem">
      <span className="fd-stem__name">{name}</span>
      <div className="fd-waves fd-waves--stem" data-on="" data-tone={tone}>
        {bars.map((h, i) => (
          <i key={i} style={{ height: `${h}%` }} />
        ))}
      </div>
    </div>
  );
}

async function script(a: Act<S>) {
  await a.wait(700);
  for (const pct of [18, 37, 58, 76, 92, 100]) {
    a.put({ pct });
    await a.wait(420);
  }
  a.mark("split");
  a.put({ split: true });
  await a.wait(2400);
  a.put({ split: false });
  await a.wait(560);
  await a.snap({ pct: 0 });
}

export default function VocalDemo() {
  return (
    <Stage<S> width={560} height={232} theme="dark" initial={initial} poster={poster} script={script} className="fd fd--whole">
      {(s) => (
        <div className="fd-panel">
          <Track name="Исходник" bars={MIX} />
          <div className="fd-clip-bar">
            <Meter value={s.pct / 100} tone={s.pct === 100 ? "success" : "accent"} style={{ flex: 1 }} />
            <States
              align="end"
              value={s.pct === 100 ? "done" : "busy"}
              states={{
                busy: <span className="fd-meta">Разделяем</span>,
                done: <Badge tone="success" icon={<Check on size={12} />}>Готово</Badge>,
              }}
            />
          </div>
          <Collapse open={s.split} reveal="drop">
            <div className="fd-stems">
              <Track name="Голос" bars={VOICE} tone="voice" />
              <Track name="Музыка" bars={MUSIC} tone="music" />
            </div>
          </Collapse>
        </div>
      )}
    </Stage>
  );
}
