import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";

import "./PowerCards.css";

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="pcKeys">
      {keys.map((key) => (
        <kbd className="pcKey mono" key={key}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

/** Пункты и сочетания — как в command-palette.tsx; «блюр» оставляет один */
const PALETTE_GROUPS: Array<{ title: string; rows: Array<{ icon: RedesignIconName; label: string; keys: string[]; match?: boolean }> }> = [
  {
    title: "Действия",
    rows: [
      { icon: "add", label: "Добавить стрим", keys: ["Ctrl", "N"] },
      { icon: "play", label: "Запустить очередь", keys: ["Ctrl", "↵"] },
    ],
  },
  {
    title: "Навигация",
    rows: [
      { icon: "queue", label: "Открыть Очередь", keys: ["G", "Q"] },
      { icon: "blur", label: "Открыть Блюр спонсоров", keys: ["G", "P"], match: true },
      { icon: "chat", label: "Открыть Рендер чата", keys: ["G", "C"] },
      { icon: "settings", label: "Открыть Настройки", keys: ["Ctrl", ","] },
    ],
  },
];

export const LOG_ROWS: Array<{ time: string; level: "info" | "warn"; text: string }> = [
  { time: "03:41:02", level: "info", text: "Очередь: 3 потока, 133 MB/s" },
  { time: "03:41:05", level: "info", text: "M3U8: ссылка найдена, 1 284 кандидата" },
  { time: "03:41:09", level: "warn", text: "Трекер потерял баннер — зона восстановлена" },
  { time: "03:41:12", level: "info", text: "Mute: заглушено 37 фрагментов" },
  { time: "03:41:15", level: "info", text: "Рендер чата: 1080p60 · 214 fps" },
  { time: "03:41:18", level: "info", text: "Vocal Remover: стемы готовы" },
  { time: "03:41:20", level: "info", text: "Запись: rostikfacekid в эфире" },
];

export function PowerCards() {
  return (
    <div className="layer pc" data-p="pc">
      <div className="pcCard pcPalette" data-p="pc.card">
        <div className="pcSearch">
          <RedesignIcon name="finder" size={18} />
          <span className="pcQuery" data-p="pc.query" />
          <span className="caret pcCaret" data-p="pc.caret" />
          <Keys keys={["Esc"]} />
        </div>
        {PALETTE_GROUPS.map((group) => (
          <div className="pcGroup" data-p={group.rows.some((row) => row.match) ? "pc.keepGroup" : "pc.dropGroup"} key={group.title}>
            <div className="pcSection">{group.title}</div>
            {group.rows.map((row, index) => (
              <div
                className="pcRow"
                data-p={row.match ? "pc.match" : "pc.drop"}
                data-first={index === 0 && group.title === "Действия" ? "" : undefined}
                key={row.label}
              >
                <span className="pcRowHi" data-p={row.match ? "pc.match.hi" : undefined} />
                <RedesignIcon name={row.icon} size={17} />
                <span className="pcRowLabel">{row.label}</span>
                <Keys keys={row.keys} />
              </div>
            ))}
          </div>
        ))}
        <div className="pcFoot mono">↑↓ навигация · ↵ открыть · Esc закрыть</div>
      </div>

      <div className="pcCard pcPresets" data-p="pc.card">
        <div className="pcCardHead">
          <b>Пресеты</b>
          <span>стримеры, чат и блюр — в один клик</span>
        </div>
        <div className="pcCols">
          {[
            { title: "M3U8 Finder", items: ["leva2k", "rostikfacekid", "xqc"] },
            { title: "Рендер чата", items: ["на сайт · 22px", "вертикалки · 28px"] },
            { title: "Блюр спонсоров", items: ["rostikfacekid · 3 зоны", "leva2k · 1 зона"] },
          ].map((column) => (
            <div className="pcCol" key={column.title}>
              <div className="pcColTitle">{column.title}</div>
              {column.items.map((item) => (
                <span className="pcPreset" data-p="pc.preset" key={item}>
                  {item}
                </span>
              ))}
            </div>
          ))}
        </div>
        <div className="pcAuto">
          <RedesignIcon name="info" size={16} />
          <span>Пресеты выбираются прямо при добавлении задачи и над экраном блюра</span>
        </div>
      </div>

      <div className="pcCard pcLogs" data-p="pc.card">
        <div className="pcCardHead">
          <b>Логи</b>
          <span>видно каждый шаг пайплайна</span>
        </div>
        <div className="pcLogList">
          {LOG_ROWS.map((row) => (
            <div className="pcLog" data-p="pc.log" key={row.time}>
              <span className="mono pcLogTime">{row.time}</span>
              <span className={`pcLevel pcLevel-${row.level}`}>{row.level}</span>
              <span className="pcLogText">{row.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
