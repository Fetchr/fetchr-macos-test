import { PlatformIcon, RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { STREAMS, type Stream } from "../content";
import "./QueueView.css";

export interface QueueRow {
  id: string;
  stream: Stream;
  meta: string;
  sizeGiB: number;
  /** Прогресс в начале сцены, % */
  p0: number;
  /** Сек от старта сцены, когда закачка доходит до 100%; null — не качается */
  doneAt: number | null;
  /** Сек от старта сцены, когда закачка начинается (для ожидающих) */
  startAt?: number;
  speed: number;
  state: "running" | "queued" | "done";
  note?: string;
}

export const NEW_ROW: QueueRow = {
  id: "new",
  stream: STREAMS.leva,
  meta: "VOD • 07:48:12",
  sizeGiB: 9.4,
  p0: 0,
  doneAt: null,
  speed: 0,
  state: "queued",
};

export const QUEUE_ROWS: QueueRow[] = [
  { id: "geo", stream: STREAMS.geo, meta: "Видео • 01:12:40", sizeGiB: 2.1, p0: 58, doneAt: 10.29, speed: 38.9, state: "running" },
  { id: "xqc", stream: STREAMS.xqc, meta: "VOD • 06:14:22", sizeGiB: 7.84, p0: 31, doneAt: 40, speed: 52.4, state: "running" },
  { id: "rostik", stream: STREAMS.rostik, meta: "VOD • 04:02:47", sizeGiB: 4.36, p0: 12, doneAt: 34, speed: 41.7, state: "running" },
  { id: "hls", stream: STREAMS.hls, meta: "HLS • 02:20:05", sizeGiB: 3.02, p0: 0, doneAt: 44, startAt: 10.57, speed: 44.3, state: "queued" },
];

function Row({ row, index }: { row: QueueRow; index: number }) {
  const running = row.state === "running";
  const queued = row.state === "queued";
  return (
    <div className="qRow" data-p={`q.row.${row.id}`} style={{ top: index * 76 }}>
      <div className="qRowFlash" data-p={`q.row.${row.id}.flash`} />
      <div className="qName">
        <div className="qThumb">
          <img className="qThumbImg" src={row.stream.thumb} alt="" />
        </div>
        <div className="qNameText">
          <div className="qTitle">{row.stream.title}</div>
          <div className="qMeta">{row.meta}</div>
        </div>
      </div>
      <div className="qSource">
        <div className="qSourceHead">
          <PlatformIcon platform={row.stream.platform} size={15} />
          {row.stream.source}
        </div>
        <div className="qUrl mono">{row.stream.url.replace(/^https:\/\/(www\.)?/, "")}</div>
      </div>
      <div className="qStatus">
        <div className="qStatusStack">
          <span className="qStatusItem" data-p={`q.row.${row.id}.st.queued`} style={{ opacity: queued ? 1 : 0 }}>
            <span className="dot" style={{ background: "var(--fetchr-color-text-tertiary)" }} />
            В очереди
          </span>
          <span className="qStatusItem qStatusRun" data-p={`q.row.${row.id}.st.running`} style={{ opacity: running ? 1 : 0 }}>
            <span className="dot" style={{ background: "var(--fetchr-color-accent)" }} />
            Загрузка
          </span>
          <span className="qStatusItem qStatusDone" data-p={`q.row.${row.id}.st.done`} style={{ opacity: row.state === "done" ? 1 : 0 }}>
            <span className="dot" style={{ background: "var(--fetchr-color-success)" }} />
            Завершено
          </span>
        </div>
        <div className="qStatusNote">{row.note ?? (queued ? "Ждёт свободный поток" : "Скачивание сегментов")}</div>
      </div>
      <div className="qCell mono" data-p={`q.row.${row.id}.speed`}>
        —
      </div>
      <div className="qCell mono" data-p={`q.row.${row.id}.eta`}>
        —
      </div>
      <div className="qCell mono" data-p={`q.row.${row.id}.size`}>
        —
      </div>
      <div className="qProgress">
        <div className="qBar">
          <div className="qBarFill" data-p={`q.row.${row.id}.fill`} />
          <div className="qBarDone" data-p={`q.row.${row.id}.done`} />
        </div>
        <span className="qPct mono" data-p={`q.row.${row.id}.pct`}>
          0%
        </span>
      </div>
      <div className="qActions">
        <span className="qIconBtn">
          <RedesignIcon name="more" size={15} />
        </span>
        <span className="qIconBtn">
          <RedesignIcon name="folder" size={15} />
        </span>
        <span className="qIconBtn">
          <RedesignIcon name="trash" size={15} />
        </span>
      </div>
    </div>
  );
}

export function QueueView() {
  return (
    <div className="view qView" data-p="view.queue">
      <div className="panel qPanel">
        <div className="qToolbar">
          <div className="seg qFilters">
            {[
              ["Все", "5"],
              ["Активные", "3"],
              ["В очереди", "1"],
              ["Завершены", "0"],
              ["Ошибки", "0"],
            ].map(([label, count], index) => (
              <span className={`segItem${index === 0 ? " segItemActive" : ""}`} key={label}>
                {label}
                <span className="qCount mono">{count}</span>
              </span>
            ))}
          </div>
          <div className="qToolbarActions">
            <span className="btn btnGhost qSquare">
              <RedesignIcon name="trash" size={16} />
            </span>
            <span className="btn btnPrimary" data-p="q.add">
              <RedesignIcon name="add" size={16} />
              Добавить задачу
            </span>
            <span className="btn btnGhost">
              <RedesignIcon name="play" size={15} />
              Запустить
            </span>
          </div>
        </div>
        <div className="qHead">
          <span>Название</span>
          <span>Источник</span>
          <span>Статус</span>
          <span>Скорость</span>
          <span>ETA</span>
          <span>Размер</span>
          <span>Прогресс</span>
          <span />
        </div>
        <div className="qRows" data-p="q.rows">
          <Row row={NEW_ROW} index={0} />
          {QUEUE_ROWS.map((row, index) => (
            <Row row={row} index={index + 1} key={row.id} />
          ))}
        </div>
        <div className="qFooter">
          <span className="mono" data-p="q.footer.count">
            4 задачи
          </span>
          <span>
            Активные загрузки: <b className="mono">3</b>
          </span>
          <span>
            Скорость: <b className="mono" data-p="q.footer.speed">133 MB/s</b>
          </span>
          <span>
            Одновременных потоков: <b className="mono">3 / 3</b>
          </span>
          <span className="qAutoscroll">
            Автопрокрутка
            <span className="check">
              <span className="checkFill" style={{ opacity: 1 }}>
                <RedesignIcon name="check" size={13} strokeWidth={3} />
              </span>
            </span>
          </span>
        </div>
      </div>
      <AddTaskModal />
    </div>
  );
}

const PLATFORM_TABS = [
  { id: "twitch", label: "twitch.tv" },
  { id: "youtube", label: "youtube.com" },
  { id: "kick", label: "kick.com" },
  { id: "hls", label: "m3u8" },
] as const;

function AddTaskModal() {
  return (
    <div className="atLayer" data-p="at">
      <div className="atOverlay" data-p="at.overlay" />
      <div className="atDialog" data-p="at.dialog">
        <div className="atHeader">
          <span className="atTitle">Добавить задачу</span>
          <span className="qIconBtn atClose">
            <RedesignIcon name="close" size={16} />
          </span>
        </div>
        <div className="atTabs" data-p="at.tabs">
          <span className="atTabPill" data-p="at.tabPill" />
          {PLATFORM_TABS.map((tab) => (
            <span className="atTab" data-p={`at.tab.${tab.id}`} key={tab.id}>
              <PlatformIcon platform={tab.id} size={16} />
              {tab.label}
            </span>
          ))}
        </div>
        <div className="atBody">
          <div className="atForm">
            <div className="field atUrl" data-p="at.url">
              <RedesignIcon name="link" size={16} />
              <span className="atUrlText" data-p="at.url.text" />
              <span className="caret" data-p="at.url.caret" />
              <span className="atPlaceholder" data-p="at.url.placeholder">
                https://www.twitch.tv/…
              </span>
            </div>
            <div className="atRow">
              <div className="field atGrow">
                <span className="atName" data-p="at.name">{NEW_ROW.stream.title}</span>
              </div>
              <div className="field atQuality">
                Лучшее · 1080p60
                <RedesignIcon name="chevronDown" size={15} />
              </div>
            </div>
            <div className="field">
              <RedesignIcon name="folder" size={16} />
              D:\Streams\leva2k
            </div>
            <div className="atRange">
              <span className="field mono atTime">00:00:00</span>
              <span className="atDash">—</span>
              <span className="field mono atTime">07:48:12</span>
              <span className="btn btnGhost">
                <RedesignIcon name="add" size={15} />
                Добавить диапазон
              </span>
            </div>
            <div className="atOptions">
              {[
                { id: "chat", icon: "chat", label: "Скачивать чат", on: true, extra: "leva2k" },
                { id: "blur", icon: "blur", label: "Блюр спонсоров", on: false, extra: "Пресет: leva2k" },
                { id: "mute", icon: "audio", label: "Очистить от матов (Fetchr Mute)", on: false },
                { id: "restore", icon: "audio", label: "Вернуть звук, заглушённый на Twitch", on: false },
              ].map((option) => (
                <div className="atOption" data-p={`at.opt.${option.id}`} key={option.id}>
                  <span className="check">
                    <span className="checkFill" data-p={`at.opt.${option.id}.fill`} style={{ opacity: option.on ? 1 : 0 }}>
                      <RedesignIcon name="check" size={13} strokeWidth={3} />
                    </span>
                  </span>
                  <RedesignIcon name={option.icon as "chat"} size={16} className="atOptIcon" />
                  <span className="atOptLabel">{option.label}</span>
                  {option.extra && <span className="chip atOptExtra">{option.extra}</span>}
                </div>
              ))}
            </div>
          </div>
          <div className="atPreview">
            <div className="atPlayer" data-p="at.player">
              <div className="atPlayerEmpty" data-p="at.player.empty">
                <PlatformIcon platform="twitch" size={56} strokeWidth={1.4} />
              </div>
              <div className="atPlayerFrame" data-p="at.player.frame">
                <img className="atFrameImg" src={NEW_ROW.stream.image} alt="" />
                <div className="atPlayerBar">
                  <RedesignIcon name="play" size={16} />
                  <div className="atScrub">
                    <div className="atScrubFill" />
                  </div>
                  <span className="mono">00:00 / 7:48:12</span>
                </div>
              </div>
            </div>
            <div className="atMarks">
              <span className="btn btnGhost">
                <RedesignIcon name="time" size={15} />
                Начало
              </span>
              <span className="btn btnGhost">
                <RedesignIcon name="time" size={15} />
                Конец
              </span>
            </div>
            <div className="atInfo" data-p="at.info">
              <div>
                <span>Стример</span>
                <b>leva2k</b>
              </div>
              <div>
                <span>Длительность</span>
                <b className="mono">7:48:12</b>
              </div>
              <div>
                <span>Источник</span>
                <b>Twitch · 1080p60</b>
              </div>
            </div>
          </div>
        </div>
        <div className="atFooter">
          <span className="btn btnGhost">Отмена</span>
          <span className="btn btnPrimary" data-p="at.submit">
            <RedesignIcon name="add" size={16} />
            Добавить в очередь
          </span>
        </div>
      </div>
    </div>
  );
}
