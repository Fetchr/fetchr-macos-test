/** Daily size of the Telegram channel, for the admin dashboard: one line
 * `{ day, members }` per day in channel-members.jsonl. Only a count. */

import { appendJsonLine, readJsonLines } from "./store.mjs";

export function createChannelStats({ api, channel, path, now = () => Date.now(), log }) {
  let lastDay = readJsonLines(path).at(-1)?.day || "";

  /** At most one request a day; a failure is retried on the next poll. */
  async function record() {
    if (!channel) return null;
    const day = new Date(now()).toISOString().slice(0, 10);
    if (day === lastDay) return null;
    try {
      const members = await api("getChatMemberCount", { chat_id: channel });
      if (!Number.isInteger(members)) return null;
      appendJsonLine(path, { day, members });
      lastDay = day;
      return members;
    } catch (err) {
      log.error(`Channel size not recorded: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  return { record };
}
