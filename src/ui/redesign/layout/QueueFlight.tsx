import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { prefersReducedMotion } from "@/ui/redesign/theme/gsapSetup";
import { badgeBump, queueFlight } from "@/ui/redesign/theme/gsapMotion";

import styles from "./QueueFlight.module.css";

interface Flight {
  id: number;
  label: string;
  from: { x: number; y: number };
}

/** Вкладка «Очередь» в топбаре и её счётчик — цель и место приземления */
const QUEUE_TAB_SELECTOR = '[data-nav-target="queue"]';
const QUEUE_BADGE_SELECTOR = "[data-nav-badge]";

const listeners = new Set<(flight: Flight) => void>();
let nextId = 0;

/**
 * Показать, куда ушла задача: пилюля с её именем вылетает из кнопки,
 * которая её поставила, и приземляется на вкладку «Очередь», а счётчик
 * вкладки вздрагивает. Работает с любой страницы — слой смонтирован в
 * оболочке приложения. При «уменьшить движение» ничего не летит: список
 * очереди и счётчик и так обновятся сами.
 */
export function launchQueueFlight(origin: Element | null | undefined, label: string) {
  if (!origin || prefersReducedMotion() || listeners.size === 0) return;
  const rect = origin.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const flight: Flight = {
    id: ++nextId,
    label,
    from: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
  };
  listeners.forEach((listener) => listener(flight));
}

export function QueueFlightLayer() {
  const [flights, setFlights] = useState<Flight[]>([]);

  useEffect(() => {
    const listener = (flight: Flight) => setFlights((items) => [...items, flight]);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (flights.length === 0) return null;

  return createPortal(
    <div className={styles.layer} aria-hidden>
      {flights.map((flight) => (
        <FlightChip
          key={flight.id}
          flight={flight}
          onDone={() => setFlights((items) => items.filter((item) => item.id !== flight.id))}
        />
      ))}
    </div>,
    document.body,
  );
}

function FlightChip({ flight, onDone }: { flight: Flight; onDone: () => void }) {
  const chipRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useLayoutEffect(() => {
    const chip = chipRef.current;
    const tab = document.querySelector(QUEUE_TAB_SELECTOR);
    const target = tab?.getBoundingClientRect();
    // Вкладка скрыта (узкое окно) — лететь некуда, пилюля просто не появится
    if (!chip || !tab || !target || target.width === 0) {
      doneRef.current();
      return;
    }

    const timeline = queueFlight(chip, flight.from, {
      x: target.left + target.width / 2,
      y: target.top + target.height / 2,
    });
    timeline.eventCallback("onComplete", () => {
      const badge = tab.querySelector(QUEUE_BADGE_SELECTOR);
      if (badge) badgeBump(badge);
      doneRef.current();
    });
    return () => {
      timeline.kill();
    };
  }, [flight]);

  return (
    <div ref={chipRef} className={styles.chip}>
      <RedesignIcon name="download" className={styles.chipIcon} />
      <span className={styles.chipLabel}>{flight.label}</span>
    </div>
  );
}
