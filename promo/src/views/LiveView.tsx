import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { STREAMS } from "../content";
import "./LiveView.css";

function Toggle({ id, on }: { id: string; on: boolean }) {
  return (
    <span className="toggle" data-p={`lv.toggle.${id}`}>
      <span className="toggleOn" data-p={`lv.toggle.${id}.on`} style={{ opacity: on ? 1 : 0 }} />
      <span className="toggleKnob" data-p={`lv.toggle.${id}.knob`} style={{ transform: on ? "translateX(16px)" : undefined }} />
    </span>
  );
}

/** «Запись стримов»: карточки записей слева, форма новой записи справа */
export function LiveView() {
  return (
    <div className="view lvView" data-p="view.live">
      <div className="lvMain">
        <div className="lvHeader">
          <span className="lvHeading">Записи</span>
          <span className="chip">
            <span className="dot" style={{ background: "var(--fetchr-color-danger)" }} />
            <span data-p="lv.liveCount">1 в эфире</span>
          </span>
        </div>

        {/* Ждёт эфира, потом стартует сама */}
        <div className="panel lvCard" data-p="lv.wait">
          <div className="lvThumb">
            <img className="lvThumbImg" src={STREAMS.rostik.thumb} alt="" />
            <div className="lvThumbShade" data-p="lv.wait.shade" />
            <div className="lvRadar" data-p="lv.wait.radar">
              <span className="lvRing" data-p="lv.wait.ring" />
              <span className="lvRing" data-p="lv.wait.ring" />
              <RedesignIcon name="live" size={26} />
            </div>
          </div>
          <div className="lvInfo">
            <div className="lvTop">
              <span className="lvName">rostikfacekid</span>
              <span className="lvBadgeStack">
                <span className="lvBadge lvBadgeWait" data-p="lv.wait.badgeWait">
                  Ожидание
                </span>
                <span className="lvBadge lvBadgeLive" data-p="lv.wait.badgeLive">
                  <span className="dot" data-p="lv.wait.recDot" />
                  REC
                </span>
              </span>
            </div>
            <div className="lvTitle">{STREAMS.rostik.title}</div>
            <div className="lvStats">
              <div className="lvStatStack">
                <span className="lvStat" data-p="lv.wait.check">
                  <RedesignIcon name="refresh" size={14} />
                  Проверка через <b className="mono" data-p="lv.wait.countdown">5 с</b>
                </span>
                <span className="lvStat lvStatLive" data-p="lv.wait.rec">
                  <RedesignIcon name="time" size={14} />
                  <b className="mono" data-p="lv.wait.timer">00:00:00</b>
                  <span className="lvSep">·</span>
                  <b className="mono">1080p60</b>
                  <span className="lvSep">·</span>
                  <b className="mono" data-p="lv.wait.size">0 MB</b>
                </span>
              </div>
            </div>
            <div className="lvSchedule">
              <RedesignIcon name="time" size={13} />
              Расписание сохранится при перезапуске
            </div>
          </div>
        </div>

        {/* Уже пишется */}
        <div className="panel lvCard" data-p="lv.rec">
          <div className="lvThumb">
            <img className="lvThumbImg" src={STREAMS.xqc.thumb} alt="" />
            <span className="lvLivePill">
              <span className="dot" />
              LIVE
            </span>
          </div>
          <div className="lvInfo">
            <div className="lvTop">
              <span className="lvName">xQc</span>
              <span className="lvBadge lvBadgeLive lvBadgeStatic">
                <span className="dot" data-p="lv.rec.recDot" />
                REC
              </span>
            </div>
            <div className="lvTitle">{STREAMS.xqc.title}</div>
            <div className="lvStats">
              <span className="lvStat lvStatLive">
                <RedesignIcon name="time" size={14} />
                <b className="mono" data-p="lv.rec.timer">01:12:44</b>
                <span className="lvSep">·</span>
                <b className="mono">1080p60</b>
                <span className="lvSep">·</span>
                <b className="mono" data-p="lv.rec.size">3.41 GB</b>
              </span>
            </div>
            <div className="lvActions">
              <span className="btn btnGhost" data-p="lv.split">
                <RedesignIcon name="media" size={15} />
                Отделить отрезок
              </span>
              <span className="btn btnGhost">
                <RedesignIcon name="stop" size={13} />
                Остановить
              </span>
              <span className="chip lvSegment" data-p="lv.segment">
                <RedesignIcon name="check" size={13} />
                Отрезок 1 · 01:12:52 — готов к монтажу
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="lvSide">
        <div className="lvSideTitle">Новая запись</div>
        <div className="lvSideSub">Стрим запишется в фоне — окно можно сворачивать</div>
        <div className="fieldLabel">Ссылка на стрим</div>
        <div className="field">
          <RedesignIcon name="link" size={16} />
          https://www.twitch.tv/rostikfacekid
        </div>
        <div className="fieldLabel lvGap">Папка сохранения</div>
        <div className="field">
          <RedesignIcon name="folder" size={16} />
          D:\Streams\rostikfacekid
        </div>
        <div className="lvBlock">
          <div className="lvBlockHead">
            <RedesignIcon name="sparkle" size={15} />
            Постобработка
          </div>
          <div className="lvBlockSub">Применяется при отделении отрезков и остановке записи</div>
          {[
            { id: "mute", label: "Удалять маты", hint: "Fetchr Mute", on: true },
            { id: "blur", label: "Заблюрить спонсоров", hint: "Sponsor Blur", on: false },
            { id: "music", label: "Удалить музыку", hint: "Vocal Remover", on: false },
            { id: "chat", label: "Чат в JSON", hint: "Для рендера чата", on: true },
          ].map((row) => (
            <div className="lvToggleRow" key={row.id}>
              <div>
                <div className="lvToggleLabel">{row.label}</div>
                <div className="lvToggleHint">{row.hint}</div>
              </div>
              <Toggle id={row.id} on={row.on} />
            </div>
          ))}
        </div>
      </div>
      <div className="lvToast" data-p="lv.toast">
        <span className="lvToastIcon">
          <RedesignIcon name="live" size={16} />
        </span>
        <div>
          <b>rostikfacekid в эфире</b>
          <span>Запись началась автоматически</span>
        </div>
      </div>
    </div>
  );
}
