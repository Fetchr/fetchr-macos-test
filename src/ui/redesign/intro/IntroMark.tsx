import { useId, type SVGProps } from "react";

import {
  BRAND_ACCENT,
  MARK_VIEWBOX,
  SPLIT_F_BODY,
  WORDMARK_LETTERS,
} from "@/ui/redesign/brand/FetchrBrand";

/*
 * Сцена интро «Вырезка». Рамка viewBox — сам знак, как у BrandMark в топбаре,
 * поэтому перелёт в шапку считается по знаку. Всё остальное — лента записи,
 * скобки-триммеры, буквы «etchr» — рисуется в тех же единицах за пределами
 * рамки (overflow: visible): буквы стоят правее знака ровно как в локапе.
 *
 * По умолчанию разметка показывает итоговый кадр (знак и слово). Начальные
 * состояния выставляет таймлайн; если он не соберётся, кадр останется верным.
 */
export function IntroMark(props: SVGProps<SVGSVGElement>) {
  // useId отдаёт ":r0:" — двоеточия в url(#…) лучше не проверять на прочность.
  const uid = useId().replace(/:/g, "");
  const id = (name: string) => `${uid}-${name}`;

  return (
    <svg viewBox={MARK_VIEWBOX} overflow="visible" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <mask id={id("body")} maskUnits="userSpaceOnUse" x="-20" y="-20" width="160" height="140">
          <rect data-intro-part="bodyMaskRect" x="-20" y="-20" width="160" height="140" fill="#ffffff" />
        </mask>
        <clipPath id={id("word")}>
          <rect data-intro-part="wordClip" x="91" y="0" width="300" height="110" />
        </clipPath>
      </defs>
      <g data-intro-part="fx" />
      <g data-intro-part="markGroup" fill={BRAND_ACCENT}>
        <path data-intro-part="body" d={SPLIT_F_BODY} mask={`url(#${id("body")})`} />
        <rect data-intro-part="chip" x="67" y="48" width="24" height="19" rx="4" />
      </g>
      <g data-intro-part="letters" fill="currentColor" clipPath={`url(#${id("word")})`}>
        {WORDMARK_LETTERS.map((d) => (
          <path key={d.slice(0, 16)} d={d} />
        ))}
      </g>
      <g data-intro-part="fxTop" />
    </svg>
  );
}
