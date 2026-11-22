import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { BANNER, STREAMS } from "../content";
import { EmoteGlyph, type Emote } from "../views/ChatView";
import "./Takeovers.css";

/** Зоны, которые ИИ находит на кадре Dota: наш баннер и два оверлея стримера */
export const BLUR_ZONES = [
  { id: "banner", label: "MATCHPULSE", left: 560, top: 150, width: 700, height: 300 },
  { id: "upgrader", label: "UPGRADER", left: 1704, top: 338, width: 200, height: 92 },
  { id: "fonbet", label: "FONBET", left: 1698, top: 455, width: 216, height: 74 },
] as const;

/**
 * Блюр спонсоров на весь кадр: настоящий стрим, поверх — рекламная
 * интеграция. Трекер находит её и ещё два спонсорских оверлея.
 */
export function BlurTakeover() {
  return (
    <div className="layer tk tkBlur" data-p="tb">
      <div className="tkScene" data-p="tb.scene">
        <img className="tkImage" src={STREAMS.rostik.image} alt="" />
        <div className="tbBannerMove" data-p="tb.bannerMove">
          <img className="tbBanner" src={BANNER} alt="" data-p="tb.banner" />
        </div>
        {BLUR_ZONES.slice(1).map((zone) => (
          <div
            className="tbFrost"
            data-p={`tb.frost.${zone.id}`}
            key={zone.id}
            style={{ left: zone.left, top: zone.top, width: zone.width, height: zone.height }}
          />
        ))}
        <div className="tbScan" data-p="tb.scan" />
        {BLUR_ZONES.map((zone, index) => (
          <div
            className="tbZone"
            data-p={`tb.zone.${zone.id}`}
            key={zone.id}
            style={{ left: zone.left - 8, top: zone.top - 8, width: zone.width + 16, height: zone.height + 16 }}
          >
            <span className="tbHandle tbHandleTl" />
            <span className="tbHandle tbHandleTr" />
            <span className="tbHandle tbHandleBl" />
            <span className="tbHandle tbHandleBr" />
            <span className={`tbLabel${index > 0 ? " tbLabelLeft" : ""}`}>
              <RedesignIcon name="sparkle" size={13} />
              {zone.label}
              <b className="mono" data-p={`tb.zone.${zone.id}.frames`}>
                0 кадров
              </b>
            </span>
          </div>
        ))}
      </div>
      <div className="tkHud tbHud" data-p="tb.hud">
        <div className="tkHudHead">
          <RedesignIcon name="blur" size={16} />
          Блюр спонсоров
          <span className="tkHudState mono" data-p="tb.hud.state">
            ИИ-трекер
          </span>
        </div>
        <div className="tkBar">
          <div className="tkBarFill" data-p="tb.hud.fill" />
        </div>
        <div className="tbMuted" data-p="tb.muted">
          <RedesignIcon name="audio" size={15} />
          Звук интеграции заглушён · 00:41:12 — 00:43:05
        </div>
      </div>
    </div>
  );
}

const CHAT_FEED: Array<{ nick: string; color: string; text: string; emotes?: Emote[] }> = [
  { nick: "Pouryana", color: "#c3a6ff", text: "banana boy", emotes: ["lol"] },
  { nick: "LamboOrDi3", color: "#9be15d", text: "HE DID IT", emotes: ["pog", "pog"] },
  { nick: "rank1_vam", color: "#5aa9ff", text: "Holy cringe" },
  { nick: "twasi", color: "#ff6b6b", text: "clip it", emotes: ["fire"] },
  { nick: "Wolfieee", color: "#ffc533", text: "LIVE LIVE LIVE" },
  { nick: "juicer_42", color: "#ff8fc6", text: "chat is this real", emotes: ["wow"] },
  { nick: "moder_ivan", color: "#2fd49b", text: "клип в описании" },
  { nick: "xqcL_enjoyer", color: "#7fd3ff", text: "WAYTOODANK", emotes: ["pog"] },
  { nick: "pixel_owl", color: "#b39dff", text: "ахахах", emotes: ["lol", "lol"] },
  { nick: "sasha_k", color: "#ffa45b", text: "кто-нибудь, запишите это" },
  { nick: "fetchr_user", color: "#5a93ff", text: "уже в рендере", emotes: ["fire"] },
  { nick: "kotelok", color: "#9be15d", text: "GG", emotes: ["gg", "gg", "gg"] },
  { nick: "lunaa", color: "#ff6b9a", text: "чат, дышим" },
  { nick: "byte_samurai", color: "#7fd3ff", text: "качество как на стриме", emotes: ["wow"] },
];

export const CHAT_FEED_LENGTH = CHAT_FEED.length;

/**
 * Рендер чата на весь кадр: стрим xQc, справа — чат, собранный Fetchr,
 * с рожицами вместо смайлов и плашкой рендера внизу.
 */
export function ChatTakeover() {
  return (
    <div className="layer tk tkChat" data-p="tc">
      <div className="tkScene" data-p="tc.scene">
        <img className="tkImage" src={STREAMS.xqc.image} alt="" />
        <div className="tcPanel" data-p="tc.panel">
          <div className="tcFeed" data-p="tc.feed">
            {CHAT_FEED.map((message, index) => (
              <div className="tcMsg" data-p="tc.msg" key={index}>
                <span className="tcNick" style={{ color: message.color }}>
                  {message.nick}
                </span>
                <span className="tcText">{message.text}</span>
                {message.emotes?.map((emote, emoteIndex) => (
                  <EmoteGlyph kind={emote} key={emoteIndex} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="tkHud tcHud" data-p="tc.hud">
        <div className="tkHudHead">
          <RedesignIcon name="chat" size={16} />
          Рендер чата
          <span className="tcChips">
            {["1440p60", "7TV", "BTTV", "FFZ"].map((chip) => (
              <span className="chip" key={chip}>
                {chip}
              </span>
            ))}
          </span>
        </div>
        <div className="tkBar">
          <div className="tkBarFill" data-p="tc.hud.fill" />
        </div>
        <div className="tkHudFoot mono">
          <span data-p="tc.hud.pct">0%</span>
          <span data-p="tc.hud.fps">0 fps</span>
          <span className="tcDone" data-p="tc.hud.done">
            <RedesignIcon name="check" size={14} />
            chat_xqc_1440p.mp4
          </span>
        </div>
      </div>
    </div>
  );
}
