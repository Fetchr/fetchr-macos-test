import { useCallback, useEffect, useRef } from "react";
import type React from "react";

import { revealInside } from "../components/review/reveal";

/** Сколько ждать после ручной прокрутки, прежде чем снова вести за словом. */
export const USER_SCROLL_HOLD_MS = 3000;
/** Своя плавная прокрутка длится до scrollend; запасной срок — если события нет. */
const OWN_SCROLL_FALLBACK_MS = 2000;

/**
 * Прокрутка панели к текущему слову, пока пользователь сам не крутил её
 * последние 3 с. `revealNow` — явный переход: снимает паузу и крутит сразу.
 * `paused` — не вести вовсе (открыто меню слова).
 */
export function useFollowScroll(
  containerRef: React.RefObject<HTMLElement | null>,
  targetSelector: string | null,
  paused = false,
) {
  const userScrollAt = useRef(0);
  const ownScrolling = useRef(false);
  const ownScrollTimer = useRef<number | undefined>(undefined);

  const beginOwnScroll = useCallback(() => {
    ownScrolling.current = true;
    window.clearTimeout(ownScrollTimer.current);
    ownScrollTimer.current = window.setTimeout(() => {
      ownScrolling.current = false;
    }, OWN_SCROLL_FALLBACK_MS);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const markUser = () => {
      userScrollAt.current = performance.now();
    };
    // Колесо, касание и захват полосы прокрутки — всегда пользователь, даже
    // посреди своей плавной прокрутки: она прерывается, scroll дальше — его.
    const markUserInput = () => {
      ownScrolling.current = false;
      window.clearTimeout(ownScrollTimer.current);
      markUser();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === el) markUserInput();
    };
    const onScroll = () => {
      if (!ownScrolling.current) markUser();
    };
    const onScrollEnd = () => {
      ownScrolling.current = false;
      window.clearTimeout(ownScrollTimer.current);
    };
    el.addEventListener("wheel", markUserInput, { passive: true });
    el.addEventListener("touchmove", markUserInput, { passive: true });
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("scrollend", onScrollEnd, { passive: true });
    return () => {
      el.removeEventListener("wheel", markUserInput);
      el.removeEventListener("touchmove", markUserInput);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("scrollend", onScrollEnd);
      window.clearTimeout(ownScrollTimer.current);
    };
  }, [containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !targetSelector || paused) return;
    if (performance.now() - userScrollAt.current < USER_SCROLL_HOLD_MS) return;
    const target = el.querySelector<HTMLElement>(targetSelector);
    if (!target) return;
    const box = el.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (rect.top >= box.top && rect.bottom <= box.bottom) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    beginOwnScroll();
    // Крутим только панель: scrollIntoView потащил бы и страницу.
    const top = el.scrollTop + rect.top - box.top - (box.height - rect.height) / 2;
    el.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
  }, [containerRef, targetSelector, paused, beginOwnScroll]);

  return useCallback(
    (target: HTMLElement) => {
      const el = containerRef.current;
      if (!el) return;
      userScrollAt.current = 0;
      beginOwnScroll();
      revealInside(el, target);
    },
    [containerRef, beginOwnScroll],
  );
}
