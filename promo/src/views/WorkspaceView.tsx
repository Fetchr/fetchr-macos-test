import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";

import { STREAMS } from "../content";
import "./WorkspaceView.css";

/**
 * Конструктор рабочих пространств: библиотека блоков слева, холст с сеткой
 * справа. Названия блоков — из workspaceBlockRegistry приложения.
 */

const LIBRARY: Array<{ id: string; icon: RedesignIconName; title: string; hint: string }> = [
  { id: "add", icon: "add", title: "Добавить задачу", hint: "Twitch, YouTube, Kick, m3u8" },
  { id: "queue", icon: "queue", title: "Очередь задач", hint: "Активные и завершённые" },
  { id: "chat", icon: "preview", title: "Chat Preview", hint: "Позиция чата в кадре" },
  { id: "blur", icon: "blur", title: "Sponsor Blur Preview", hint: "Кадр с зонами блюра" },
  { id: "status", icon: "status", title: "Системный статус", hint: "Движок и потоки" },
  { id: "logs", icon: "logs", title: "Логи", hint: "Сообщения задач" },
  { id: "search", icon: "finder", title: "M3U8 Public Search", hint: "Публичные VOD по нику" },
];

/** Клетка сетки холста */
export const CELL = { w: 72, h: 74, gap: 10 };

/** Блоки на холсте: x/y/w/h — в клетках сетки 12×8 */
export const BLOCKS = [
  { id: "queue", title: "Очередь задач", icon: "queue" as const, x: 0, y: 0, w: 7, h: 4 },
  { id: "status", title: "Системный статус", icon: "status" as const, x: 7, y: 0, w: 5, h: 2 },
  { id: "logs", title: "Логи", icon: "logs" as const, x: 7, y: 2, w: 5, h: 2 },
  { id: "chat", title: "Chat Preview", icon: "preview" as const, x: 0, y: 4, w: 5, h: 4, dragged: true },
  { id: "blur", title: "Sponsor Blur Preview", icon: "blur" as const, x: 5, y: 4, w: 7, h: 4, dragged: true },
];

export const blockRect = (block: { x: number; y: number; w: number; h: number }) => ({
  left: block.x * (CELL.w + CELL.gap),
  top: block.y * (CELL.h + CELL.gap),
  width: block.w * (CELL.w + CELL.gap) - CELL.gap,
  height: block.h * (CELL.h + CELL.gap) - CELL.gap,
});

function BlockBody({ id }: { id: string }) {
  if (id === "queue") {
    return (
      <div className="wsRows">
        {[STREAMS.leva, STREAMS.geo, STREAMS.xqc, STREAMS.rostik].map((stream, index) => (
          <div className="wsRow" key={stream.id}>
            <img src={stream.thumb} alt="" />
            <span className="wsRowTitle">{stream.title}</span>
            <span className="wsRowBar">
              <span style={{ width: `${[18, 100, 64, 41][index]}%` }} className={index === 1 ? "wsDone" : undefined} />
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (id === "status") {
    return (
      <div className="wsStats">
        {[
          ["133 MB/s", "скорость"],
          ["3 / 3", "потоки"],
          ["1", "в эфире"],
        ].map(([value, label]) => (
          <div className="wsStat" key={label}>
            <b className="mono">{value}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
    );
  }
  if (id === "logs") {
    return (
      <div className="wsLogs mono">
        <span>
          <i>19:04:12</i> rostikfacekid вышел в эфир — запись
        </span>
        <span>
          <i>19:04:31</i> GEO: скачано 2.10 GiB
        </span>
        <span>
          <i>19:05:02</i> Блюр: 3 зоны отслежены
        </span>
      </div>
    );
  }
  if (id === "chat") {
    return (
      <div className="wsFrame">
        <img src={STREAMS.xqc.thumb} alt="" />
        <span className="wsChatBox" />
      </div>
    );
  }
  return (
    <div className="wsFrame">
      <img src={STREAMS.rostik.thumb} alt="" />
      <span className="wsZoneBox" />
    </div>
  );
}

export function WorkspaceView() {
  return (
    <div className="view wsView" data-p="view.ws">
      <aside className="wsLibrary">
        <div className="wsLibraryHead">
          <span>Библиотека блоков</span>
          <span className="chip">13</span>
        </div>
        <div className="field wsSearch">
          <RedesignIcon name="finder" size={15} />
          Найти блок
        </div>
        {LIBRARY.map((item) => (
          <div className="wsItem" data-p={`ws.lib.${item.id}`} key={item.id}>
            <span className="wsItemIcon">
              <RedesignIcon name={item.icon} size={16} />
            </span>
            <span className="wsItemText">
              <b>{item.title}</b>
              <span>{item.hint}</span>
            </span>
          </div>
        ))}
      </aside>

      <section className="wsMain">
        <div className="wsToolbar">
          <div className="seg">
            <span className="segItem segItemActive">Стример</span>
            <span className="segItem">Монтаж</span>
            <span className="segItem">
              <RedesignIcon name="add" size={14} />
              Новое
            </span>
          </div>
          <span className="btn btnPrimary wsSave">
            <RedesignIcon name="save" size={15} />
            Сохранить
          </span>
        </div>
        <div className="wsCanvas" data-p="ws.canvas">
          {BLOCKS.map((block) => (
            <div className="wsDrop" data-p={`ws.drop.${block.id}`} key={`drop-${block.id}`} style={blockRect(block)} />
          ))}
          {BLOCKS.map((block) => (
            <div className="wsBlock" data-p={`ws.block.${block.id}`} key={block.id} style={blockRect(block)}>
              <div className="wsBlockHead">
                <RedesignIcon name={block.icon} size={14} />
                {block.title}
                <RedesignIcon name="move" size={13} className="wsGrip" />
              </div>
              <BlockBody id={block.id} />
            </div>
          ))}
        </div>
      </section>
      {/* Призрак блока, который тащат из библиотеки */}
      <div className="wsGhost" data-p="ws.ghost">
        <RedesignIcon name="preview" size={14} />
        <span data-p="ws.ghost.label">Chat Preview</span>
      </div>
    </div>
  );
}
