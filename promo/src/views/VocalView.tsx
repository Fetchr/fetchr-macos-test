import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { waveform } from "../lib/procedural";
import "./VocalView.css";

const MIX = waveform(3, 170, "mix");
const VOICE = waveform(8, 170, "speech");
const MUSIC = waveform(11, 170, "music");

/** Музыкальные зоны на таймлайне 12:53: 0:23–0:24 и 3:15–4:06 */
export const MUSIC_ZONES = [
  { from: 23 / 773, to: 25 / 773, label: "0:23–0:24" },
  { from: 195 / 773, to: 246 / 773, label: "3:15–4:06" },
];

function Wave({ values, tone, id }: { values: number[]; tone: "mix" | "voice" | "music"; id: string }) {
  return (
    <div className={`vcWave vcWave-${tone}`} data-p={id}>
      {values.map((value, index) => (
        <span className="vcBar" style={{ height: `${10 + value * 86}%` }} key={index} />
      ))}
    </div>
  );
}

export function VocalView() {
  return (
    <div className="view vcView" data-p="view.vocal">
      <div className="vcMain">
        <div className="panel muFile">
          <span className="muFileIcon">
            <RedesignIcon name="audio" size={20} />
          </span>
          <div className="muFileText">
            <b>final_cut.mp4</b>
            <span className="mono">12:53 · D:\Streams\montage</span>
          </div>
          <span className="vcModel" data-p="vc.model">
            <RedesignIcon name="cpu" size={14} />
            Windowed RoFormer
          </span>
        </div>

        <div className="panel vcStems">
          <div className="muHead">
            <span>Разделение на стемы</span>
            <span className="vcProgress mono">
              <span data-p="vc.split.pct">0%</span>
            </span>
          </div>
          <div className="vcRow" data-p="vc.row.mix">
            <span className="vcRowIcon">
              <RedesignIcon name="media" size={16} />
            </span>
            <div className="vcRowText">
              <b>Исходный микс</b>
              <span className="mono">final_cut.mp4</span>
            </div>
            <Wave values={MIX} tone="mix" id="vc.wave.mix" />
            <div className="vcSweep" data-p="vc.sweep" />
          </div>
          <div className="vcRow vcRowStem" data-p="vc.row.voice">
            <span className="vcRowIcon vcIconVoice">
              <RedesignIcon name="audio" size={16} />
            </span>
            <div className="vcRowText">
              <b>Голос</b>
              <span className="mono">final_cut_vocals.wav</span>
            </div>
            <Wave values={VOICE} tone="voice" id="vc.wave.voice" />
          </div>
          <div className="vcRow vcRowStem" data-p="vc.row.music">
            <span className="vcRowIcon vcIconMusic">
              <RedesignIcon name="sparkle" size={16} />
            </span>
            <div className="vcRowText">
              <b>Музыка</b>
              <span className="mono">final_cut_instrumental.wav</span>
            </div>
            <Wave values={MUSIC} tone="music" id="vc.wave.music" />
          </div>
        </div>

        <div className="panel vcCopy" data-p="vc.copy">
          <div className="muHead">
            <span>Анти-Copyright</span>
            <span className="vcSteps">детекция → очистка → рекомпозинг</span>
          </div>
          <div className="vcTimeline">
            <div className="vcTimelineWave" />
            {MUSIC_ZONES.map((zone, index) => (
              <div
                className="vcZone"
                data-p="vc.zone"
                style={{ left: `${zone.from * 100}%`, width: `${Math.max(0.8, (zone.to - zone.from) * 100)}%` }}
                key={index}
              >
                <span className="vcZoneLabel mono">{zone.label}</span>
              </div>
            ))}
            <div className="vcScan" data-p="vc.scan" />
          </div>
          <div className="vcFound" data-p="vc.found">
            <span className="vcArt" />
            <div className="vcFoundText">
              <b>Коммерческий трек</b>
              <span>Найден по аудиоотпечатку · 3:15–4:06</span>
            </div>
            <span className="vcFoundStack">
              <span className="vcChip vcChipWarn" data-p="vc.found.warn">
                риск страйка
              </span>
              <span className="vcChip vcChipOk" data-p="vc.found.ok">
                <RedesignIcon name="check" size={13} strokeWidth={2.6} />
                очищено
              </span>
            </span>
          </div>
        </div>
      </div>

      <div className="panel vcSide">
        <div className="fieldLabel">Задача</div>
        <div className="vcCard" data-p="vc.task.stems">
          <b>Разделить на стемы</b>
          <span>vocals.wav + instrumental.wav</span>
        </div>
        <div className="vcCard" data-p="vc.task.copy">
          <b>Анти-Copyright</b>
          <span className="vcAccent">детекция → очистка → рекомпозинг</span>
        </div>
        <div className="vcSelect" data-p="vc.task.pill" />
        <div className="fieldLabel vcGap">Режим</div>
        {[
          ["Быстрый (Kim Inst)", "приоритет — скорость", false],
          ["Студийный (Windowed RoFormer)", "приоритет — качество", true],
          ["Максимум 2025 (Mel-Band RoFormer)", "топ-качество, нужен GPU", false],
        ].map(([title, hint, active]) => (
          <div className={`vcCard${active ? " vcCardActive" : ""}`} key={String(title)}>
            <b>{title}</b>
            <span>{hint}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
