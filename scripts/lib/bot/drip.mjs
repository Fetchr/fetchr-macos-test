/** Follow-ups after a first key: a day later, tips that prevent the most
 * common failures; on day four, the free Archive VPS plan (shop open only).
 *
 * Only keys issued after this feature first ran are followed up — nobody who
 * got a key before hears from it. Each step goes once; «Не присылать советы»
 * stops the rest. Who got what and who opted out are kept as hashes of the
 * Telegram id, never the id itself. */

import { createHash } from "node:crypto";

import { appendJsonLine, readJsonLines } from "./store.mjs";
import { btn, keyboard } from "./ui.mjs";

const HOUR_MS = 3_600_000;
const STALE_MS = 14 * 24 * HOUR_MS;

const hash = (value) => createHash("sha256").update(`fetchr-drip:${value}`).digest("hex").slice(0, 24);

export function tipsScreen() {
  return {
    text: [
      "💡 <b>Три совета, чтобы Fetchr качал без сбоев</b>",
      "",
      "1. <b>Twitch обрывает загрузку или пишет «прокси требует логин»</b> — проверьте VPN и прокси: Fetchr → Настройки → Сеть и прокси. Чаще всего помогает выключить прокси или сменить сервер VPN.",
      "2. <b>YouTube просит войти</b> — закройте браузер полностью (он держит cookies) и повторите загрузку.",
      "3. <b>Нужен только кусок стрима</b> — задайте фрагмент при добавлении: скачается только он, в разы быстрее.",
      "",
      "Не получилось — напишите в поддержку, разберёмся.",
    ].join("\n"),
    markup: keyboard([[btn("💬 Поддержка", "sup")], [btn("🔕 Не присылать советы", "drip:off")]]),
  };
}

export function archiveOfferScreen() {
  return {
    text: [
      "📼 <b>Стримы, которые записываются сами</b>",
      "",
      "Архив VPS записывает выбранного стримера на нашем сервере — даже когда ваш компьютер выключен. Записи потом скачиваются в Fetchr одним кликом.",
      "",
      "Попробуйте бесплатно: тариф <b>Free</b> — 5 ГБ и один стример.",
    ].join("\n"),
    markup: keyboard([
      [btn("✅ Подключить бесплатно", "free", "success")],
      [btn("🛒 Все тарифы", "shop:rub"), btn("🔕 Не присылать", "drip:off")],
    ]),
  };
}

export function createDrip({ path, licenseRecords, send, now = () => Date.now(), log }) {
  // Only service onboarding tips; promotional offers require separate opt-in consent (152-ФЗ ст. 15).
  const steps = [{ id: "tips", after: 24 * HOUR_MS, screen: tipsScreen }];

  function state() {
    const lines = readJsonLines(path);
    const startedAt = lines.find((line) => line?.started_at)?.started_at;
    return {
      startedAt: startedAt ? Date.parse(startedAt) : null,
      sent: new Set(lines.map((line) => line?.sent).filter(Boolean)),
      off: new Set(lines.map((line) => line?.off).filter(Boolean)),
    };
  }

  /** First key time per account, for keys issued after the drip started. */
  function newcomers(since) {
    const first = new Map();
    for (const record of licenseRecords()) {
      const user = record?.telegram_user_id;
      const at = Date.parse(record?.issued_at);
      if (!user || record.revoked_at || !Number.isFinite(at)) continue;
      if (!first.has(user) || at < first.get(user)) first.set(user, at);
    }
    // Someone who had a key before the start is not a newcomer.
    const veterans = new Set(licenseRecords()
      .filter((record) => record?.telegram_user_id && Date.parse(record.issued_at) < since)
      .map((record) => record.telegram_user_id));
    return [...first].filter(([user, at]) => at >= since && !veterans.has(user));
  }

  /** Sends what is due, one step per person per tick; returns how many went out. */
  async function tick(at = now()) {
    const current = state();
    if (!current.startedAt) {
      appendJsonLine(path, { started_at: new Date(at).toISOString() });
      return 0;
    }
    let sent = 0;
    for (const [user, keyAt] of newcomers(current.startedAt)) {
      if (current.off.has(hash(user)) || at - keyAt > STALE_MS) continue;
      const step = steps.find((item) => !current.sent.has(hash(`${user}:${item.id}`)) && at - keyAt >= item.after);
      if (!step) continue;
      // Marked first: a blocked bot or a crash never sends it twice.
      appendJsonLine(path, { sent: hash(`${user}:${step.id}`), step: step.id, at: new Date(at).toISOString() });
      try {
        await send(user, step.screen());
        sent += 1;
      } catch (err) {
        log.error(`Follow-up ${step.id} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return sent;
  }

  function optOut(userId) {
    appendJsonLine(path, { off: hash(userId), at: new Date(now()).toISOString() });
  }

  return { tick, optOut };
}
