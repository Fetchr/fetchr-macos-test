/**
 * Разбор времени, которое вводит или вставляет пользователь.
 *
 * Понимает «01:23:45», «23:45», «5025» (секунды), «5025s», «1h23m45s»,
 * «01h23m45s» (Twitch) и «1m30s» (YouTube). Пусто или мусор даёт null.
 */
export function parseTimeInput(value: string | null | undefined): number | null {
  const text = value?.trim().toLowerCase();
  if (!text) return null;

  if (/^\d+(:\d{1,2}){0,2}$/.test(text)) {
    const parts = text.split(":").map(Number);
    // Минуты и секунды после двоеточия не бывают больше 59.
    if (parts.slice(1).some((part) => part > 59)) return null;
    return parts.reduce((sum, part) => sum * 60 + part, 0);
  }

  const units = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (units && (units[1] || units[2] || units[3])) {
    return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  }
  return null;
}

/** Секунды в «ЧЧ:ММ:СС» с ведущими нулями. */
export function formatHms(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((part) => String(part).padStart(2, "0")).join(":");
}

/**
 * Время начала из ссылки: `?t=01h23m45s` у Twitch, `?t=450`, `t=450s`,
 * `t=1m30s` или `start=450` у YouTube, а также `#t=…`. Без метки — null.
 */
export function parseUrlStartTime(url: string | null | undefined): number | null {
  const text = url?.trim();
  if (!text) return null;
  const match = text.match(/[?&#](?:t|start|time_continue)=([0-9hms:]+)/i);
  if (!match) return null;
  const seconds = parseTimeInput(match[1]);
  return seconds && seconds > 0 ? seconds : null;
}
