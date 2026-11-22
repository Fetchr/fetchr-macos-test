/**
 * Единственное место регистрации GSAP.
 *
 * Плагины регистрируются один раз на модуль: повторный registerPlugin
 * безвреден, но тогда порядок инициализации начинает зависеть от того,
 * какой компонент отрендерился первым.
 *
 * Кривые создаются через CustomEase из тех же четырёх значений, что лежат
 * в fetchrTokens.css (--fetchr-ease-*). Приблизительные аналоги вроде
 * "expo.out" разошлись бы с CSS-переходами, которые остаются на кнопках и
 * ховерах: одна и та же анимация выглядела бы по-разному в JS и в CSS.
 */
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { Flip } from "gsap/Flip";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(useGSAP, CustomEase, Flip, ScrollTrigger);

/** cubic-bezier(x1,y1,x2,y2) в путь, который понимает CustomEase */
const bezier = (x1: number, y1: number, x2: number, y2: number) =>
  `M0,0 C${x1},${y1} ${x2},${y2} 1,1`;

CustomEase.create("fetchrOut", bezier(0.16, 1, 0.3, 1));
CustomEase.create("fetchrStandard", bezier(0.2, 0, 0, 1));
CustomEase.create("fetchrCine", bezier(0.22, 1, 0.36, 1));
CustomEase.create("fetchrPop", bezier(0.34, 1.56, 0.64, 1));

/** Имена кривых, зеркало --fetchr-ease-* */
export const EASE = {
  out: "fetchrOut",
  standard: "fetchrStandard",
  cine: "fetchrCine",
  pop: "fetchrPop",
} as const;

/** Длительности в секундах, зеркало --fetchr-dur-* (те заданы в мс) */
export const DUR = {
  fast: 0.12,
  base: 0.18,
  slow: 0.26,
  slower: 0.4,
} as const;

let reduced = false;

/** Читают билдеры таймлайнов, чтобы не собирать анимацию впустую. */
export const prefersReducedMotion = () => reduced;

/**
 * Системная настройка «уменьшить движение».
 *
 * Заменяет MotionConfig reducedMotion="user". timeScale на глобальном
 * таймлайне — страховка для твинов, созданных мимо билдеров: они доиграют
 * мгновенно, а не будут проигнорированы, поэтому onComplete всё равно
 * сработает и узлы, ждущие конца выхода, размонтируются.
 *
 * CSS-блок prefers-reduced-motion в globals.css остаётся: GSAP не управляет
 * CSS-переходами ховеров и бесконечными keyframes вроде LIVE-пульса.
 */
export function initGsapEnvironment() {
  const mm = gsap.matchMedia();
  mm.add("(prefers-reduced-motion: reduce)", () => {
    reduced = true;
    gsap.globalTimeline.timeScale(1000);
    return () => {
      reduced = false;
      gsap.globalTimeline.timeScale(1);
    };
  });
  return () => mm.revert();
}

export { gsap, Flip, ScrollTrigger, useGSAP };
