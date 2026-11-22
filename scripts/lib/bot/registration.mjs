/** Registration: channel subscription check and license keys bound to a
 *  Machine ID. Keys go to the same JSONL the API server reads for
 *  /license/status, in the same record shape. */

import { deviceLimitScreen, invalidMachineIdScreen, keyScreen, registrationScreen } from "./screens.mjs";
import { appendJsonLine, readJsonLines } from "./store.mjs";

export function extractMachineId(text) {
  const value = String(text || "");
  const fromStart = value.match(/fetchr_([A-Fa-f0-9]{32})(?![A-Fa-f0-9])/);
  if (fromStart) return fromStart[1];
  return value.match(/\b[A-Fa-f0-9]{32}\b/)?.[0] ?? null;
}

export const DEVICE_LIMIT = 1;

export function createLicenseBook({ path, createLicenseKey, normalizeMachineId, now = () => Date.now() }) {
  /** Newest live key per machine this Telegram account registered. */
  function devices(userId) {
    const latest = new Map();
    for (const record of readJsonLines(path)) {
      if (record?.telegram_user_id !== userId || !record.machine_id || !record.license_key) continue;
      const machineId = String(record.machine_id).toUpperCase();
      if (record.revoked_at) latest.delete(machineId);
      else latest.set(machineId, { machineId, key: record.license_key, issuedAt: record.issued_at });
    }
    return [...latest.values()].sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
  }

  /** Throws on a malformed Machine ID. Re-sending a registered ID returns the
   *  key already issued for it instead of minting a second one. An account
   *  holds one device: another live one comes back as `limit` until it is
   *  reset in the personal account on the site. */
  function issue(user, rawMachineId) {
    const machineId = normalizeMachineId(rawMachineId);
    const own = devices(user.id);
    const existing = own.find((device) => device.machineId === machineId);
    if (existing) return { machineId, key: existing.key, reused: true };
    if (own.length >= DEVICE_LIMIT) return { machineId, limit: true, current: own[0].machineId };
    // The key is a readable, signed token kept by the client: no name or id in it.
    const key = createLicenseKey({ machine_id: machineId });
    appendJsonLine(path, {
      issued_at: new Date(now()).toISOString(),
      machine_id: machineId,
      license_key: key,
      telegram_user_id: user.id || null,
    });
    return { machineId, key, reused: false };
  }

  function isValid(rawMachineId) {
    try {
      normalizeMachineId(rawMachineId);
      return true;
    } catch {
      return false;
    }
  }

  /** Registered and not expired yet: reset keys are deleted 30 days after the
   *  reset, so callers also treat a buyer with orders as having an account. */
  function known(userId) {
    return readJsonLines(path).some((record) => record?.telegram_user_id === userId);
  }

  /** Every line of the key log, for jobs that look across accounts. */
  const records = () => readJsonLines(path);

  return { devices, isValid, issue, known, records };
}

export function createRegistration({ api, config, licenses, sessions, consents, show, log }) {
  /** true / false, null when the check itself failed, undefined without a channel. */
  async function checkSubscription(userId) {
    if (!config.requiredChannel) return undefined;
    try {
      const member = await api("getChatMember", { chat_id: config.requiredChannel, user_id: userId });
      if (["creator", "administrator", "member"].includes(member?.status)) return true;
      return member?.status === "restricted" && Boolean(member.is_member);
    } catch (err) {
      log.error(`Subscription check failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  const consented = (userId) => !consents || consents.has(userId);

  function screenFor(from, subscribed, notice = "") {
    return registrationScreen({
      channel: config.requiredChannel,
      channelUrl: config.requiredChannelUrl,
      subscribed,
      consented: consented(from.id),
      devices: licenses.devices(from.id),
      pendingMachineId: sessions.get(from.id).pendingMachineId || "",
      notice,
    });
  }

  /** Only a malformed ID is the user's problem. A signing or disk failure
   *  propagates to the generic error path, so the reply never shows an env
   *  variable or a server path. */
  async function issue(chatId, messageId, from, machineId) {
    if (!licenses.isValid(machineId)) {
      return show(chatId, messageId, invalidMachineIdScreen({ reason: "Machine ID — это 32 символа: цифры 0–9 и буквы A–F." }));
    }
    // A key stores the Machine ID, so it waits for consent; the ID stays
    // pending and step 1 (consent) finishes the job once the user agrees.
    // Only reached once the subscription is confirmed or not required.
    if (!consented(from.id)) {
      sessions.set(from.id, { pendingMachineId: machineId.toUpperCase() });
      return show(chatId, messageId, screenFor(from, config.requiredChannel ? true : undefined));
    }
    const result = licenses.issue(from, machineId);
    sessions.set(from.id, { pendingMachineId: null });
    if (result.limit) {
      return show(
        chatId,
        messageId,
        deviceLimitScreen({ current: result.current, requested: result.machineId, accountUrl: config.accountUrl || "https://fetchr.fun/account/" }),
      );
    }
    return show(
      chatId,
      messageId,
      keyScreen({
        machineId: result.machineId,
        licenseKey: result.key,
        channel: config.requiredChannel,
        fresh: true,
        shop: Boolean(config.shopEnabled),
      }),
    );
  }

  return {
    checkSubscription,

    /** «Согласен, проверить подписку» on step 1: record the consent, check the
     *  channel and carry on — step 2, or the key for a waiting Machine ID. */
    async consent(chatId, messageId, from) {
      consents?.give(from.id);
      const subscribed = await checkSubscription(from.id);
      const pending = sessions.get(from.id).pendingMachineId;
      if (pending && subscribed !== false && subscribed !== null) {
        await issue(chatId, messageId, from, pending);
        return "Согласие сохранено";
      }
      await show(chatId, messageId, screenFor(from, subscribed));
      if (subscribed === true) return "Подписка есть ✓";
      if (subscribed === false) return "Согласие сохранено. Подписка пока не найдена";
      if (subscribed === null) return "Согласие сохранено. Подписку проверить не удалось — попробуйте позже";
      return "Согласие сохранено";
    },

    async open(chatId, messageId, from, { notice = "" } = {}) {
      const subscribed = await checkSubscription(from.id);
      const pending = sessions.get(from.id).pendingMachineId;
      if (pending && subscribed !== false && subscribed !== null) return issue(chatId, messageId, from, pending);
      return show(chatId, messageId, screenFor(from, subscribed, notice));
    },

    /** "Я подписался": re-check, and finish a registration that was waiting on it. */
    async recheck(chatId, messageId, from) {
      const subscribed = await checkSubscription(from.id);
      const pending = sessions.get(from.id).pendingMachineId;
      if (subscribed === true && pending) return issue(chatId, messageId, from, pending);
      await show(chatId, messageId, screenFor(from, subscribed));
      if (subscribed === true) return null;
      return subscribed === null ? "Не удалось проверить подписку — попробуйте позже" : "Подписка пока не найдена";
    },

    async register(chatId, from, machineId) {
      const subscribed = await checkSubscription(from.id);
      if (subscribed === false || subscribed === null) {
        sessions.set(from.id, { pendingMachineId: machineId.toUpperCase() });
        const notice = subscribed === false ? "📢 <b>Почти готово</b> — подпишитесь на канал, и ключ придёт сразу." : "";
        return show(chatId, null, screenFor(from, subscribed, notice));
      }
      return issue(chatId, null, from, machineId);
    },

    async showKey(chatId, messageId, from, machineId) {
      const device = licenses.devices(from.id).find((item) => item.machineId === String(machineId).toUpperCase());
      if (!device) return "Ключ не найден";
      const screen = keyScreen({
        machineId: device.machineId,
        licenseKey: device.key,
        channel: config.requiredChannel,
        fresh: false,
        shop: Boolean(config.shopEnabled),
      });
      await show(chatId, messageId, screen);
      return null;
    },
  };
}
