import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { pageIn, pageOut } from "@/ui/redesign/theme/gsapMotion";

interface PageTransitionProps {
  /** Ключ маршрута: его смена и есть сигнал к переходу */
  routeKey: string;
  children: ReactNode;
}

/**
 * Переход между страницами: выход старой, затем вход новой.
 *
 * Прежний AnimatePresence mode="wait" удерживал уходящее дерево сам. Здесь
 * это делается явно: в момент смены маршрута старый узел «замораживается» в
 * состоянии и продолжает рисоваться, пока играет выход. Новые children в это
 * время игнорируются, а после onComplete заморозка снимается, и React
 * показывает уже актуальную страницу.
 *
 * Пока маршрут тот же, children рендерятся напрямую: страница должна
 * перерисовываться от обновлений стора, а не показывать снимок из состояния.
 */
export function PageTransition({ routeKey, children }: PageTransitionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [frozen, setFrozen] = useState<{ key: string; node: ReactNode } | null>(null);
  const previousRef = useRef<{ key: string; node: ReactNode }>({ key: routeKey, node: children });
  const mountedRef = useRef(false);

  if (!frozen && routeKey !== previousRef.current.key) {
    setFrozen(previousRef.current);
  }
  if (!frozen) previousRef.current = { key: routeKey, node: children };

  // Выход: играет поверх замороженного узла
  useLayoutEffect(() => {
    if (!frozen) return;
    const container = containerRef.current;
    if (!container) {
      setFrozen(null);
      return;
    }
    const timeline = pageOut(container);
    timeline.eventCallback("onComplete", () => setFrozen(null));
    return () => {
      timeline.kill();
    };
  }, [frozen]);

  // Вход: после того как заморозка снята и отрисовалась новая страница.
  // Первый монтаж пропускается — открытие приложения не должно фейдиться.
  useLayoutEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (frozen) return;
    const container = containerRef.current;
    if (container) pageIn(container);
  }, [routeKey, frozen]);

  return (
    <div ref={containerRef} className="h-full w-full min-h-0 min-w-0">
      {frozen ? frozen.node : children}
    </div>
  );
}
