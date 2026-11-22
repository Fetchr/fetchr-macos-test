import { IntroMark } from "@/ui/redesign/intro/IntroMark";

import { HERO_TAGLINE, OUTRO, POWER } from "../content";
import "./Scenery.css";

/** Атмосфера: два медленных световых пятна и виньетка */
export function Backdrop() {
  return (
    <div className="layer bd" data-p="bd">
      <div className="bdGlow bdGlowA" data-p="bd.a" />
      <div className="bdGlow bdGlowB" data-p="bd.b" />
      <div className="bdFloor" data-p="bd.floor" />
      <div className="bdVignette" />
    </div>
  );
}

/** Логотип в центре кадра: та же плитка и та же буква, что в интро приложения */
export function LogoLockup({ id, size }: { id: string; size: number }) {
  return (
    <div className="lk" data-p={`${id}`} style={{ ["--mark" as string]: `${size}px` }}>
      <div className="lkMarkWrap" data-p={`${id}.markWrap`}>
        <div className="lkGlow" data-p={`${id}.glow`} />
        <IntroMark className="lkMark" data-p={`${id}.mark`} />
      </div>
      <div className="lkWordWrap" data-p={`${id}.wordWrap`}>
        <span className="lkWord gradText" data-p={`${id}.word`}>
          Fetchr
        </span>
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <div className="layer hero" data-p="hero">
      <div className="heroStack">
        <LogoLockup id="hero.lockup" size={150} />
        <div className="heroTagline" data-p="hero.tagline">
          <span className="lineMask">
            <span data-p="hero.tagline.line">{HERO_TAGLINE}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export function PowerTitle() {
  return (
    <div className="layer pw" data-p="pw">
      <div className="pwHead">
        <div className="pwEyebrow mono">
          <span className="lineMask">
            <span data-p="pw.line">{POWER.eyebrow}</span>
          </span>
        </div>
        <h2 className="pwTitle">
          <span className="lineMask">
            <span className="gradText" data-p="pw.line">
              {POWER.title}
            </span>
          </span>
        </h2>
      </div>
      <div className="pwLegend">
        {POWER.items.map((item) => (
          <div className="pwItem" data-p="pw.item" key={item.key}>
            <span className="pwKey mono">{item.key}</span>
            <span className="pwLabel">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Outro() {
  return (
    <div className="layer ou" data-p="ou">
      <div className="ouStack">
        <LogoLockup id="ou.lockup" size={112} />
        <h2 className="ouTitle">
          {OUTRO.title.map((line) => (
            <span className="lineMask" key={line}>
              <span className="gradText" data-p="ou.line">
                {line}
              </span>
            </span>
          ))}
        </h2>
        <div className="ouCta" data-p="ou.cta">
          <span className="ouButton" data-p="ou.button">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {OUTRO.cta}
            <span className="ouButtonSheen" data-p="ou.buttonSheen" />
          </span>
          <span className="ouMeta mono" data-p="ou.meta">
            {OUTRO.meta}
          </span>
        </div>
      </div>
    </div>
  );
}
