export const FETCHR_BETA_BOT_URL = "https://t.me/fetchr_beta_bot";

export function fetchrBetaBotUrl(startParameter?: string | null): string {
  const start = startParameter?.trim();
  return start ? `${FETCHR_BETA_BOT_URL}?start=${encodeURIComponent(start)}` : FETCHR_BETA_BOT_URL;
}
