import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { STREAMS } from "../content";
import "./BlurView.css";

/** Вымышленный спонсор: настоящие бренды в ролике не нужны */
function SponsorBanner() {
  return (
    <div className="blBanner" data-p="bl.banner">
      <div className="blBannerLogo">
        <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
          <defs>
            <linearGradient id="bl-logo" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#ffe08a" />
              <stop offset="1" stopColor="#ff8a3d" />
            </linearGradient>
          </defs>
          <circle cx="16" cy="16" r="14" fill="url(#bl-logo)" />
          <path d="M11 20.5 16 9l5 11.5h-3.3L16 16.2l-1.7 4.3Z" fill="#1c1208" />
        </svg>
      </div>
      <div className="blBannerText">
        <b>LUMEN</b>
        <span>игровые кресла · промокод STREAM20</span>
      </div>
      <span className="blBannerBadge">−20%</span>
    </div>
  );
}

export function BlurView() {
  return (
    <div className="view blView" data-p="view.blur">
      <div className="fdPresets">
        {["rostikfacekid", "leva2k"].map((name, index) => (
          <span className={`fdPreset${index === 0 ? " fdPresetActive" : ""}`} key={name}>
            <RedesignIcon name="blur" size={13} />
            {name}
          </span>
        ))}
        <span className="fdPreset fdPresetAdd">
          <RedesignIcon name="add" size={13} />
          Добавить
        </span>
      </div>

      <div className="blCanvas" data-p="bl.canvas">
        <div className="blScene" data-p="bl.scene">
          <img className="blFrame" src={STREAMS.rostik.image} alt="" />
          <div className="blBannerMove" data-p="bl.bannerMove">
            <SponsorBanner />
          </div>
        </div>
        <div className="blZone" data-p="bl.zone">
          <span className="blZoneTag">
            <RedesignIcon name="move" size={11} />
            Зона 1
          </span>
          <span className="blZoneHandle" />
        </div>
        <div className="blTopBar">
          <div className="seg blMode">
            <span className="segItem segItemActive">Кадр</span>
            <span className="segItem">Видео</span>
          </div>
          <span className="mono blZonesCount">зон блюра: 1</span>
        </div>
      </div>

      <div className="panel blTimeline">
        <div className="blTlHead">
          <span className="blTlTitle">
            <RedesignIcon name="time" size={15} />
            Таймлайн
          </span>
          <span className="mono blTlTime">
            <b data-p="bl.time">00:20:02</b> / 01:18:18
          </span>
        </div>
        <div className="blTrack">
          <span className="blTrackLabel">Время</span>
          <div className="blRuler">
            {["0:00", "0:10", "0:20", "0:30", "0:40", "0:50", "1:00", "1:10"].map((mark) => (
              <span className="mono" key={mark}>
                {mark}
              </span>
            ))}
          </div>
        </div>
        <div className="blTrack">
          <span className="blTrackLabel">Трекинг</span>
          <div className="blLane" data-p="bl.lane">
            <div className="blLaneFill" data-p="bl.laneFill" />
            <div className="blLost" data-p="bl.lost" style={{ left: "46%", width: "3%" }} />
            <div className="blLost" data-p="bl.lost" style={{ left: "71%", width: "2%" }} />
          </div>
        </div>
        <div className="blTrack">
          <span className="blTrackLabel">Звук</span>
          <div className="blLane blAudio">
            <div className="blMuted" data-p="bl.muted">
              <RedesignIcon name="hidden" size={12} />
              заглушено
            </div>
          </div>
        </div>
        <div className="blPlayhead" data-p="bl.playhead" />
        <div className="blLegend">
          <span>
            <i className="blSwatch" /> баннер найден
          </span>
          <span>
            <i className="blSwatch blSwatchLost" /> потерян
          </span>
        </div>
      </div>

      <div className="panel blSide">
        <div className="blSideHead">
          <RedesignIcon name="settings" size={15} />
          Управление
        </div>
        <div className="blTimes">
          <div>
            <div className="fieldLabel">От</div>
            <div className="field mono">00:19:25</div>
          </div>
          <div>
            <div className="fieldLabel">До</div>
            <div className="field mono">00:30:40</div>
          </div>
        </div>
        <div className="seg blEngine">
          <span className="segItem segItemActive">ИИ-трекер</span>
          <span className="segItem">Корреляция</span>
        </div>
        <div className="blParams">
          {[
            ["Шаг, с", "0.2"],
            ["Анализ", "960"],
            ["Порог", "0.45"],
          ].map(([label, value]) => (
            <div key={label}>
              <div className="fieldLabel">{label}</div>
              <div className="field mono">{value}</div>
            </div>
          ))}
        </div>
        <div className="blTrackBtn" data-p="bl.track">
          <div className="blTrackFill" data-p="bl.track.fill" />
          <span className="blTrackLabel2" data-p="bl.track.idle">
            <RedesignIcon name="sparkle" size={16} />
            Трекинг зоны
          </span>
          <span className="blTrackLabel2 blTrackBusy" data-p="bl.track.busy">
            ИИ ведёт зону · <span className="mono" data-p="bl.track.pct">0%</span>
          </span>
        </div>
        <div className="blZoneItem" data-p="bl.zoneItem">
          <span className="dot" style={{ background: "var(--fetchr-color-zone)" }} />
          Зона 1
          <span className="blZoneMeta mono" data-p="bl.zoneMeta">
            0 кадров
          </span>
          <RedesignIcon name="visible" size={15} className="blEye" />
        </div>
      </div>
    </div>
  );
}
