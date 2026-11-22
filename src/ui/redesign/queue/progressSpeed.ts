/**
 * Скорость загрузки из строки журнала загрузчика, например «… 45.77MB/s …».
 * У части задач скорости нет в самом прогрессе, она приходит только в тексте
 * журнала, и без неё сводка и график остаются нулевыми.
 */
export function speedBpsFromLogLine(line: string | null | undefined): number | null {
  if (!line) return null;
  const match = line.match(/([\d.,]+)\s?([KMGT]?i?B)(?:ps|\/s)/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toLowerCase();
  const power = unit.startsWith("k") ? 1 : unit.startsWith("m") ? 2 : unit.startsWith("g") ? 3 : unit.startsWith("t") ? 4 : 0;
  return amount * 1024 ** power;
}
