import { useEffect, useRef, useState } from "react";

/** Плавная интерполяция числа (для кинематографичного счётчика процентов) */
export function useSmoothNumber(target: number, rate = 7): number {
  const [value, setValue] = useState(target);
  const valueRef = useRef(target);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const cur = valueRef.current;
      if (Math.abs(target - cur) < 0.05) {
        valueRef.current = target;
        setValue(target);
        return;
      }
      const next = cur + (target - cur) * Math.min(1, dt * rate);
      valueRef.current = next;
      setValue(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, rate]);
  return value;
}
