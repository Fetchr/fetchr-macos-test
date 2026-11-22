import type { TFunction } from "i18next";

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/** 36,2 МБ — одна цифра после запятой, пока число меньше сотни */
export function formatSize(bytes: number, t: TFunction, locale: string): string {
  const [value, unit] =
    bytes >= GIB
      ? [bytes / GIB, "gb"]
      : bytes >= MIB
        ? [bytes / MIB, "mb"]
        : bytes >= KIB
          ? [bytes / KIB, "kb"]
          : [bytes, "b"];
  const digits = unit === "b" || value >= 100 ? 0 : 1;
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  return `${number} ${t(`boot.units.${unit}`)}`;
}

export function formatSpeed(bytesPerSecond: number, t: TFunction, locale: string): string {
  return `${formatSize(Math.max(0, bytesPerSecond), t, locale)}${t("boot.units.per_second")}`;
}

/** Оставшееся время: секунды до минуты, дальше целые минуты вверх */
export function formatEta(seconds: number, t: TFunction): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return t("boot.units.seconds", { count: Math.ceil(seconds) });
  return t("boot.units.minutes", { count: Math.ceil(seconds / 60) });
}

export function formatPercent(fraction: number): string {
  return `${Math.floor(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

/** 32 hex-символа читаются группами по четыре; копируется всё равно сырой ID */
export function groupMachineId(id: string): string {
  return id.match(/.{1,4}/g)?.join(" ") ?? "";
}
