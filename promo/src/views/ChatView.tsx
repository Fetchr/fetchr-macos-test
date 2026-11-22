import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { STREAMS } from "../content";
import "./ChatView.css";

export type Emote = "fire" | "gg" | "pog" | "lol" | "love" | "wow";

export const CHAT: Array<{ nick: string; color: string; text: string; emotes?: Emote[] }> = [
  { nick: "velo_fan", color: "#ff8a5b", text: "заходим на финал", emotes: ["fire"] },
  { nick: "kotelok", color: "#9be15d", text: "GG WP", emotes: ["gg", "gg"] },
  { nick: "arctic_fox", color: "#5aa9ff", text: "ставлю на вторую карту" },
  { nick: "vesna", color: "#e07bff", text: "привет из Казани", emotes: ["love"] },
  { nick: "moder_ivan", color: "#2fd49b", text: "клип момента в описании" },
  { nick: "ded_inside", color: "#ffc533", text: "ЭТО БЫЛО ЛЕГЕНДАРНО", emotes: ["pog", "pog", "pog"] },
  { nick: "lunaa", color: "#ff6b9a", text: "чат, дышим" },
  { nick: "byte_samurai", color: "#7fd3ff", text: "качество как на стриме", emotes: ["wow"] },
  { nick: "pixel_owl", color: "#b39dff", text: "ахахах", emotes: ["lol", "lol"] },
  { nick: "sasha_k", color: "#ffa45b", text: "кто-нибудь, запишите это" },
  { nick: "fetchr_user", color: "#5a93ff", text: "уже пишется", emotes: ["fire"] },
];

/** Смайлы — свои простые рожицы: чужие эмоуты в ролике не показываем */
export function EmoteGlyph({ kind }: { kind: Emote }) {
  const palette: Record<Emote, [string, string]> = {
    fire: ["#ff9f43", "#ff5e3a"],
    gg: ["#5ee39b", "#1fb57f"],
    pog: ["#ffd166", "#f7a531"],
    lol: ["#8fd3ff", "#4a9df8"],
    love: ["#ff8fc6", "#f0506e"],
    wow: ["#c3a6ff", "#8a63ff"],
  };
  const [light, dark] = palette[kind];
  return (
    <svg className="chEmote" viewBox="0 0 28 28" aria-hidden="true">
      <defs>
        <linearGradient id={`ch-${kind}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={light} />
          <stop offset="1" stopColor={dark} />
        </linearGradient>
      </defs>
      <circle cx="14" cy="14" r="12.5" fill={`url(#ch-${kind})`} />
      <circle cx="9.8" cy="11.5" r={kind === "pog" || kind === "wow" ? 2.4 : 1.7} fill="#1b1d22" />
      <circle cx="18.2" cy="11.5" r={kind === "pog" || kind === "wow" ? 2.4 : 1.7} fill="#1b1d22" />
      {kind === "pog" || kind === "wow" ? (
        <ellipse cx="14" cy="19.2" rx="3.4" ry="3.8" fill="#1b1d22" />
      ) : (
        <path d="M8.6 16.8c1.5 3 3.3 4.2 5.4 4.2s3.9-1.2 5.4-4.2" stroke="#1b1d22" strokeWidth="2" fill="none" strokeLinecap="round" />
      )}
    </svg>
  );
}

export function ChatView() {
  return (
    <div className="view chView" data-p="view.chat">
      <div className="fdPresets">
        {["xQc", "на сайт", "вертикалки"].map((name, index) => (
          <span className={`fdPreset${index === 0 ? " fdPresetActive" : ""}`} key={name}>
            <RedesignIcon name="chat" size={13} />
            {name}
          </span>
        ))}
        <span className="fdPreset fdPresetAdd">
          <RedesignIcon name="add" size={13} />
          Добавить
        </span>
      </div>

      <div className="chCanvas" data-p="ch.canvas">
        <img className="chFrame" src={STREAMS.leva.image} alt="" />
        <div className="chOverlay" data-p="ch.overlay">
          <div className="chOverlayTag">
            <RedesignIcon name="move" size={11} />
            Chat · 300×420
          </div>
          <div className="chViewport" data-p="ch.viewport">
            <div className="chMessages" data-p="ch.messages">
              {CHAT.map((message, index) => (
                <div className="chMsg" data-p="ch.msg" key={index}>
                  <span className="chNick" style={{ color: message.color }}>
                    {message.nick}:
                  </span>{" "}
                  <span className="chText">{message.text}</span>
                  {message.emotes?.map((emote, emoteIndex) => (
                    <EmoteGlyph kind={emote} key={emoteIndex} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="chPlayer">
          <RedesignIcon name="pause" size={15} />
          <div className="chScrub">
            <div className="chScrubFill" data-p="ch.scrub" />
          </div>
          <span className="mono" data-p="ch.time">
            01:42:10
          </span>
        </div>
      </div>

      <div className="chControls">
        <div className="chGroup">
          <div className="fieldLabel">Шрифт</div>
          <div className="field chSelect">
            Inter <RedesignIcon name="chevronDown" size={14} />
          </div>
        </div>
        <div className="chGroup">
          <div className="fieldLabel">Размер</div>
          <div className="field mono chSmall">22</div>
        </div>
        <div className="chGroup">
          <div className="fieldLabel">Вес ника</div>
          <div className="field chSelect">
            800 ExtraBold <RedesignIcon name="chevronDown" size={14} />
          </div>
        </div>
        <div className="chGroup">
          <div className="fieldLabel">Смайлы</div>
          <div className="chChips">
            {["7TV", "BTTV", "FFZ"].map((label) => (
              <span className="chToggleChip" data-p={`ch.emote.${label}`} key={label}>
                <span className="chToggleOn" data-p={`ch.emote.${label}.on`} />
                <span className="chToggleText">{label}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="panel chSide">
        <div className="chSideHead">Параметры экспорта</div>
        <div className="seg">
          <span className="segItem segItemActive">Twitch</span>
          <span className="segItem">Kick</span>
        </div>
        <div className="fieldLabel chGap">Source URL</div>
        <div className="field">
          <RedesignIcon name="link" size={16} />
          twitch.tv/videos/2289461731
        </div>
        <div className="chTimes">
          <div>
            <div className="fieldLabel chGap">Начало</div>
            <div className="field mono">01:40:00</div>
          </div>
          <div>
            <div className="fieldLabel chGap">Конец</div>
            <div className="field mono">01:55:00</div>
          </div>
        </div>
        <div className="fieldLabel chGap">Качество рендера</div>
        <div className="seg chQuality" data-p="ch.quality">
          <span className="chQualityPill" data-p="ch.quality.pill" />
          {["720p", "1080p", "1440p"].map((q) => (
            <span className="segItem" data-p={`ch.q.${q}`} key={q}>
              {q}
            </span>
          ))}
        </div>
        <span className="btn btnGhost chWide">
          <RedesignIcon name="exportJson" size={15} />
          Скачать JSON чата
        </span>
        <div className="chRenderBtn" data-p="ch.render">
          <div className="chRenderFill" data-p="ch.render.fill" />
          <span className="chRenderLabel" data-p="ch.render.idle">
            <RedesignIcon name="play" size={15} />
            Рендерить только чат
          </span>
          <span className="chRenderLabel chRenderBusy" data-p="ch.render.busy">
            <span className="mono" data-p="ch.render.pct">
              0%
            </span>
            Рендер 1080p60 · <span className="mono" data-p="ch.render.fps">0 fps</span>
          </span>
        </div>
        <span className="btn btnGhost chWide">
          <RedesignIcon name="add" size={15} />
          Добавить экспорт в очередь
        </span>
      </div>
    </div>
  );
}
