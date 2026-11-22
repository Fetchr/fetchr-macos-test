import { useMemo } from "react";

import styles from "./ActivityPanel.module.css";

/** Маленький график скорости: линия и заливка под ней. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const { line, area } = useMemo(() => {
    const max = Math.max(1, ...values);
    const step = values.length > 1 ? 100 / (values.length - 1) : 100;
    const points = values.map((value, index) => `${(index * step).toFixed(2)},${(30 - (value / max) * 26).toFixed(2)}`);
    return { line: `M${points.join(" L")}`, area: `M0,32 L${points.join(" L")} L100,32Z` };
  }, [values]);
  return (
    <svg className={className} viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden>
      <path d={area} className={styles.sparkArea} />
      <path d={line} className={styles.sparkLine} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
