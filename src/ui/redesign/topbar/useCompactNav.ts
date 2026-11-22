import { useLayoutEffect, useRef, useState } from "react";

/**
 * Whether the nav tabs have to drop their labels to fit.
 *
 * Decided from the room actually available rather than a fixed breakpoint:
 * the set of tabs depends on which tools are enabled and on the language, so
 * any single width would be wrong for someone. The width the labelled row
 * needs is remembered while labels are shown, and compact mode ends only once
 * that much room is back; measuring the compact row instead would flip the
 * two states back and forth on every resize.
 *
 * `tabsKey` changes whenever the set of tabs does, which invalidates the
 * remembered width.
 */
export function useCompactNav(tabsKey: string) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fullWidth = useRef(0);
  const compactRef = useRef(false);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    fullWidth.current = 0;
    compactRef.current = false;
    setCompact(false);

    const measure = () => {
      const available = container.clientWidth;
      if (!compactRef.current) fullWidth.current = container.scrollWidth;
      const next = fullWidth.current > available + 1;
      if (next !== compactRef.current) {
        compactRef.current = next;
        setCompact(next);
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [tabsKey]);

  return { containerRef, compact };
}
