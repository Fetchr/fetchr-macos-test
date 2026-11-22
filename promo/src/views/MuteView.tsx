import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { waveform } from "../lib/procedural";
import "./MuteView.css";

/**
 * Расшифровка фрагмента. Мат показан звёздочками — в ролике для сайта
 * его не произносят и не пишут; «блин» остаётся из белого списка.
 */
export const TRANSCRIPT: Array<Array<{ w: string; kind?: "bad" | "white" }>> = [
  [{ w: "ну" }, { w: "всё," }, { w: "заходим" }, { w: "в" }, { w: "последний" }, { w: "раунд," }, { w: "чат" }],
  [{ w: "смотрите," }, { w: "он" }, { w: "опять" }, { w: "✱✱✱✱", kind: "bad" }, { w: "через" }, { w: "мид" }, { w: "побежал" }],
  [{ w: "да" }, { w: "как" }, { w: "так-то," }, { w: "✱✱✱✱✱", kind: "bad" }, { w: "я" }, { w: "же" }, { w: "его" }, { w: "видел" }],
  [{ w: "ладно," }, { w: "блин,", kind: "white" }, { w: "это" }, { w: "было" }, { w: "красиво," }, { w: "✱✱✱", kind: "bad" }, { w: "признаю" }],
];

/** Места заглушения на волне, доли ширины — совпадают с порядком плохих слов */
export const MUTED_REGIONS = [
  { from: 0.29, to: 0.35 },
  { from: 0.53, to: 0.6 },
  { from: 0.84, to: 0.88 },
];

export const MUTE_BARS = waveform(19, 150, "speech");

export function MuteView() {
  return (
    <div className="view muView" data-p="view.mute">
      <div className="muMain">
        <div className="panel muFile">
          <span className="muFileIcon">
            <RedesignIcon name="video" size={20} />
          </span>
          <div className="muFileText">
            <b>stream_2026-09-19.mkv</b>
            <span className="mono">04:12:07 · русский · GigaAM v3</span>
          </div>
          <span className="muFileStatus">
            <RedesignIcon name="sparkle" size={14} />
            Распознавание речи
          </span>
        </div>

        <div className="panel muTranscript">
          <div className="muHead">
            <span>Расшифровка</span>
            <span className="muLegend">
              <i className="muPill muPillBad">✱✱✱</i> мат
              <i className="muPill muPillWhite">блин</i> белый список
            </span>
          </div>
          <div className="muLines">
            {TRANSCRIPT.map((line, lineIndex) => (
              <div className="muLine" key={lineIndex}>
                {line.map((word, wordIndex) => (
                  <span
                    className={`muWord${word.kind === "bad" ? " muWordBad" : ""}${word.kind === "white" ? " muWordWhite" : ""}`}
                    data-p="mu.word"
                    data-kind={word.kind ?? ""}
                    key={wordIndex}
                  >
                    {word.w}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="panel muTrack">
          <div className="muHead">
            <span>Дорожка · фрагмент 01:12:40 — 01:12:58</span>
            <span className="muCount mono">
              найдено <b data-p="mu.count">0</b> · во всём файле <b>37</b>
            </span>
          </div>
          <div className="muWave" data-p="mu.wave">
            <div className="muBars">
              {MUTE_BARS.map((value, index) => (
                <span className="muBar" data-p="mu.bar" style={{ height: `${8 + value * 88}%` }} key={index} />
              ))}
            </div>
            {MUTED_REGIONS.map((region, index) => (
              <div
                className="muRegion"
                data-p="mu.region"
                style={{ left: `${region.from * 100}%`, width: `${(region.to - region.from) * 100}%` }}
                key={index}
              >
                <svg className="muBeep" data-p="mu.beep" viewBox="0 0 60 20" preserveAspectRatio="none" aria-hidden="true">
                  <path d="M0 10 Q3.75 0 7.5 10 T15 10 T22.5 10 T30 10 T37.5 10 T45 10 T52.5 10 T60 10" fill="none" stroke="#ffb347" strokeWidth="2" />
                </svg>
                <span className="muFlat" data-p="mu.flat" />
              </div>
            ))}
            <div className="muPlayhead" data-p="mu.playhead" />
          </div>
        </div>
      </div>

      <div className="panel muSide">
        <div className="muSideHead">
          <RedesignIcon name="settings" size={15} />
          Настройки обработки
        </div>
        <div className="fieldLabel">Язык аудио</div>
        <div className="seg">
          <span className="segItem segItemActive">Русский</span>
          <span className="segItem">English</span>
        </div>
        <div className="fieldLabel muGap">Профиль глушения</div>
        <div className="seg">
          <span className="segItem">Как в референсе</span>
          <span className="segItem segItemActive">Адаптивный</span>
        </div>
        <div className="fieldLabel muGap">Способ цензурирования</div>
        <div className="seg muMethod" data-p="mu.method">
          <span className="muMethodPill" data-p="mu.method.pill" />
          <span className="segItem" data-p="mu.m.beep">
            <RedesignIcon name="audio" size={14} />
            Запикать
          </span>
          <span className="segItem" data-p="mu.m.mute">
            <RedesignIcon name="hidden" size={14} />
            Заглушить
          </span>
          <span className="segItem" data-p="mu.m.custom">
            <RedesignIcon name="folder" size={14} />
            Свой звук
          </span>
        </div>
        <div className="fieldLabel muGap">Дополнительные слова (ЧС)</div>
        <div className="muChips">
          {["п✱✱✱✱", "б✱✱✱", "х✱✱", "с✱✱✱", "з✱✱✱✱✱"].map((word) => (
            <span className="chip" key={word}>
              {word}
              <RedesignIcon name="close" size={11} />
            </span>
          ))}
        </div>
        <div className="fieldLabel muGap">Белый список</div>
        <div className="muChips">
          {["блин", "капец", "жесть"].map((word) => (
            <span className="chip muWhiteChip" key={word}>
              {word}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
