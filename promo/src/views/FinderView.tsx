import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { StreamFrame } from "../components/StreamFrame";
import { rng } from "../lib/procedural";
import "./FinderView.css";

const VODS = [
  { id: "a", title: "Ночной кооп до утра", date: "22.09 · 06:12:40", palette: "arctic", seed: 9, state: "vod" },
  { id: "b", title: "Реакция на трейлеры", date: "19.09 · 04:12:07", palette: "violet", seed: 61, state: "gone" },
  { id: "c", title: "Спидран с чатом", date: "17.09 · 02:20:05", palette: "forest", seed: 44, state: "vod" },
  { id: "d", title: "IRL: рынок и еда", date: "14.09 · 03:44:18", palette: "ember", seed: 73, state: "gone" },
  { id: "e", title: "Турнир: полуфинал", date: "11.09 · 05:01:32", palette: "dusk", seed: 5, state: "vod" },
] as const;

/** Правдоподобные адреса CDN-кандидатов: хэши и коды ответа из генератора */
export const CANDIDATES = (() => {
  const random = rng(404);
  const hex = (length: number) => Array.from({ length }, () => "0123456789abcdef"[Math.floor(random() * 16)]).join("");
  return Array.from({ length: 34 }, (_, index) => ({
    url: `https://vod-${["east", "west", "eu", "ap"][index % 4]}.cdn.net/${hex(20)}_leva2k_${48213 + index}/chunked/index-dvr.m3u8`,
    code: random() > 0.35 ? 403 : 404,
  }));
})();

export function FinderView() {
  return (
    <div className="view fdView" data-p="view.finder">
      <div className="fdPresets">
        {["leva2k", "vesna", "arctic_fox"].map((name, index) => (
          <span className={`fdPreset${index === 0 ? " fdPresetActive" : ""}`} key={name}>
            <RedesignIcon name="finder" size={13} />
            {name}
            <RedesignIcon name="close" size={12} className="fdPresetX" />
          </span>
        ))}
        <span className="fdPreset fdPresetAdd">
          <RedesignIcon name="add" size={13} />
          Добавить
        </span>
      </div>

      <div className="panel fdList">
        <div className="fieldLabel">Никнейм</div>
        <div className="fdNickRow">
          <div className="field fdGrow">leva2k</div>
          <span className="btn btnPrimary">
            <RedesignIcon name="download" size={15} />
            Загрузить VOD
          </span>
        </div>
        <div className="fdRows">
          {VODS.map((vod) => (
            <div className="fdRow" data-p={`fd.vod.${vod.id}`} key={vod.id}>
              <div className="fdRowSel" data-p={`fd.vod.${vod.id}.sel`} />
              <div className="fdThumb">
                <StreamFrame palette={vod.palette} seed={vod.seed} className="fdThumbImg" />
                {vod.state === "gone" && <div className="fdGone" />}
              </div>
              <div className="fdRowText">
                <div className="fdRowTitle">{vod.title}</div>
                <div className="fdRowMeta mono">{vod.date}</div>
              </div>
              {vod.state === "gone" ? (
                <span className="fdTag fdTagGone">404 · удалён</span>
              ) : (
                <span className="fdTag">VOD</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="panel fdRecover">
        <div className="fieldLabel">Tracker URL</div>
        <div className="fdUrlRow">
          <div className="field fdGrow">
            <RedesignIcon name="link" size={16} />
            <span data-p="fd.tracker" />
          </div>
          <span className="qIconBtn">
            <RedesignIcon name="clipboard" size={15} />
          </span>
          <span className="qIconBtn">
            <RedesignIcon name="external" size={15} />
          </span>
        </div>
        <div className="fdGrid">
          <div>
            <div className="fieldLabel">Никнейм</div>
            <div className="field">
              <span data-p="fd.fill">leva2k</span>
            </div>
          </div>
          <div>
            <div className="fieldLabel">Stream ID</div>
            <div className="field mono">
              <span data-p="fd.fill">318162780902</span>
            </div>
          </div>
          <div>
            <div className="fieldLabel">Время начала</div>
            <div className="field mono">
              <span data-p="fd.fill">2026-09-19 21:04</span>
            </div>
          </div>
          <div className="fdFindWrap">
            <span className="btn btnPrimary fdFind" data-p="fd.find">
              <RedesignIcon name="finder" size={15} />
              Найти m3u8
            </span>
          </div>
        </div>

        <div className="fdScan" data-p="fd.scan">
          <div className="fdScanHead">
            <span className="fdScanTitle">
              <RedesignIcon name="refresh" size={14} data-p="fd.scan.spin" />
              <span className="fdLabelStack">
                <span className="fdLabel" data-p="fd.scan.label">
                  Перебор CDN-кандидатов
                </span>
                <span className="fdLabel fdLabelDone" data-p="fd.scan.done">
                  Прямая ссылка найдена
                </span>
              </span>
            </span>
            <span className="mono fdScanCount">
              <b data-p="fd.scan.count">0</b> проверено
            </span>
          </div>
          <div className="fdScanBar">
            <div className="fdScanFill" data-p="fd.scan.fill" />
          </div>
          <div className="fdScanLines" data-p="fd.scan.lines">
            {CANDIDATES.map((line, index) => (
              <div className="fdLine mono" key={index} data-p="fd.scan.line">
                <span className="fdLineX">✕</span>
                <span className="fdLineUrl">{line.url}</span>
                <span className="fdLineCode">{line.code}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="fdHead">
          <span>M3U8 URL</span>
          <span>Параметры</span>
          <span>Статус</span>
          <span />
        </div>
        <div className="fdResult" data-p="fd.result">
          <div className="fdResultFlash" data-p="fd.result.flash" />
          <span className="mono fdResultUrl">vod-eu.cdn.net/9f2c…/chunked/index-dvr.m3u8</span>
          <span className="fdResultParams">
            <b>1080p60</b> · 4:12:07
          </span>
          <span className="fdResultStatus">
            <RedesignIcon name="check" size={14} strokeWidth={2.6} />
            Найден
          </span>
          <span className="btn btnPrimary fdGet" data-p="fd.get">
            <RedesignIcon name="download" size={15} />
            Скачать
          </span>
        </div>
      </div>
    </div>
  );
}
