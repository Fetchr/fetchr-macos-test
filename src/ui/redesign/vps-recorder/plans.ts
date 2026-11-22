/** What the app needs to know about the VPS archive plans.
 *
 * The price list lives on the site (vps-site/guides/pages/arhiv-vps.mjs) and
 * checkout in the Telegram bot. The app only turns the plan the agent reports
 * into a name and a quota, and quotes the entry price on the "Тарифы" link.
 * Keep the numbers here in step with both. Prices are rubles only. Sizes are decimal GB to match how the agent reports
 * disk usage.
 */

export const GB = 1e9;

export interface Plan {
  id: string;
  name: string;
  /** Included storage, in bytes. */
  quota: number;
  /** Monthly price in rubles; 0 for the free plan. */
  price: number;
  /** Streams the plan may record at the same time. */
  channels: number;
}

/** Size of one stackable add-on pack. */
const ADDON_STEP_GB = 10;

export const PLANS: Plan[] = [
  { id: "free", name: "Free", quota: 5 * GB, price: 0, channels: 1 },
  { id: "mini", name: "Мини", quota: 20 * GB, price: 100, channels: 1 },
  { id: "start", name: "Старт", quota: 50 * GB, price: 200, channels: 1 },
  { id: "streamer", name: "Стример", quota: 150 * GB, price: 500, channels: 2 },
  { id: "archive", name: "Архив", quota: 500 * GB, price: 1290, channels: 5 },
  { id: "max", name: "Макс", quota: 1000 * GB, price: 2499, channels: 5 },
];

/** Entry price of the paid plans in rubles, for "from N a month" copy. */
export function cheapestPaidPrice(): number {
  return Math.min(...PLANS.map((plan) => plan.price).filter((price) => price > 0));
}

export function fmtRub(value: number): string {
  return `${value.toLocaleString("ru-RU")} ₽`;
}

/** The price list on the site; its checkout button hands off to the bot. */
export function plansUrl(): string {
  return "https://fetchr.fun/arhiv-vps/";
}

export function planById(id: string): Plan {
  return PLANS.find((plan) => plan.id === id) ?? PLANS[0];
}

export function totalQuota(plan: Plan, packs: number): number {
  return plan.quota + packs * ADDON_STEP_GB * GB;
}

/** Hours of footage a byte budget holds at a given bitrate. `bytesPerSec` is
 *  the agent's own measurement of the channel being recorded. */
export function hoursFor(bytes: number, bytesPerSec: number | undefined): number | null {
  if (!bytesPerSec || bytesPerSec <= 0) return null;
  return bytes / bytesPerSec / 3600;
}
