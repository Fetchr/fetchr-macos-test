import type { VpsStatus } from "@/lib/ipc";

import { planById, PLANS, totalQuota, type Plan } from "./plans";

export interface ActivePlan {
  plan: Plan;
  packs: number;
  quota: number;
  paidUntil: number | null;
  managed: boolean;
}

/** The plan the agent reports, resolved against the local price list.
 *  Null when the server runs without one (a self-hosted VPS). */
export function activePlan(status: VpsStatus | null | undefined): ActivePlan | null {
  const raw = status?.subscription;
  if (!raw || !PLANS.some((plan) => plan.id === raw.plan)) return null;
  const plan = planById(raw.plan);
  const packs = Math.max(0, raw.packs ?? 0);
  // A managed archive reports its real quota as the disk total; it can differ
  // from the price list when a plan was upgraded by hand.
  const serverQuota = raw.managed ? (status?.disk?.total ?? 0) : 0;
  return {
    plan,
    packs,
    quota: serverQuota > 0 ? serverQuota : totalQuota(plan, packs),
    paidUntil: raw.paid_until ?? null,
    managed: Boolean(raw.managed),
  };
}

const DAY = 86_400;

/** Whole days left in the paid period, never negative. */
export function daysLeft(paidUntil: number | null, now = Date.now() / 1000): number | null {
  if (paidUntil == null) return null;
  return Math.max(0, Math.ceil((paidUntil - now) / DAY));
}

export function fmtPaidUntil(paidUntil: number): string {
  return new Date(paidUntil * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

/** "3 дня", "21 день", "5 дней". */
export function fmtDays(days: number): string {
  const tens = days % 100;
  const ones = days % 10;
  const word =
    tens >= 11 && tens <= 14 ? "дней" : ones === 1 ? "день" : ones >= 2 && ones <= 4 ? "дня" : "дней";
  return `${days} ${word}`;
}
