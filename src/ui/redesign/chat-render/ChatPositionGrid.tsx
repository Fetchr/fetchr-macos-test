import type { ChatPlacement } from "./ChatPreviewPlacement";
import studio from "./ChatStudio.module.css";

const CELLS = [
  ["start", "start"],
  ["center", "start"],
  ["end", "start"],
  ["start", "center"],
  ["center", "center"],
  ["end", "center"],
  ["start", "end"],
  ["center", "end"],
  ["end", "end"],
] as const;

type Align = (typeof CELLS)[number][number];

const MARGIN = 40;

function offset(align: Align, size: number, total: number): number {
  if (align === "start") return MARGIN;
  if (align === "end") return Math.max(0, total - size - MARGIN);
  return Math.max(0, Math.round((total - size) / 2));
}

/** Быстрая привязка рамки чата к одной из девяти точек кадра. */
export function ChatPositionGrid({ placement, onChange }: { placement: ChatPlacement; onChange: (next: ChatPlacement) => void }) {
  return (
    <div className={studio.posGrid} role="group" aria-label="Позиция чата на кадре">
      {CELLS.map(([h, v]) => {
        const x = offset(h, placement.width, placement.outputWidth);
        const y = offset(v, placement.height, placement.outputHeight);
        const active = Math.abs(placement.x - x) < 4 && Math.abs(placement.y - y) < 4;
        return (
          <button
            key={`${h}-${v}`}
            type="button"
            className={studio.posCell}
            aria-pressed={active}
            aria-label={`Чат: ${v === "start" ? "сверху" : v === "end" ? "снизу" : "по центру"}, ${h === "start" ? "слева" : h === "end" ? "справа" : "по центру"}`}
            onClick={() => onChange({ ...placement, x, y })}
          />
        );
      })}
    </div>
  );
}
