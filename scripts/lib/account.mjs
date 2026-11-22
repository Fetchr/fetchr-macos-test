/** Personal account on fetchr.fun. Sign-in takes the app's Machine ID and a
 *  one-time code that @fetchr_beta_bot sends to the Telegram account that
 *  registered that ID — no passwords anywhere.
 *
 *   POST /account/login    { machine_id }        -> { request_id, expires_in, hint }
 *   POST /account/verify   { request_id, code, remember? } -> sets the session cookie
 *   POST /account/tg/start                       -> { id, url, expires_in }: open the bot, tap «Войти»
 *   POST /account/tg/poll  { id, remember? }     -> { status: "pending" } | sets the session cookie
 *   GET  /account/me                             -> profile, device, subscription, purchases
 *   POST /account/device/reset { machine_id }    -> revokes that device's key
 *   POST /account/logout   { everywhere? }       -> clears the session(s)
 *
 * «Запомнить» keeps the session 30 days; without it the cookie dies with the
 * browser and the server forgets the session after a day.
 *
 * Codes and session tokens are stored only as SHA-256 hashes. Sessions survive
 * a restart (account-sessions.json); pending codes deliberately do not.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { WEB_LOGIN_PREFIX, describeBrowser } from "./web-login.mjs";
import { effectiveSubscription, grantSubscription, purchaseHistory, subscriptionOf, userOrders } from "./account-subscription.mjs";

export const CODE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const SHORT_SESSION_TTL_MS = 24 * 60 * 60_000;
export const MAX_ATTEMPTS = 5;
export const COOKIE = "fetchr_session";
const COOKIE_PATH = "/api/account";

/** One reset per week, so one key cannot be passed around machine to machine. */
export const RESET_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

export class AccountError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

function sameHash(left, right) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeMachineId(value) {
  const raw = String(value || "").trim().replace(/^fetchr_/i, "");
  return /^[A-Fa-f0-9]{32}$/.test(raw) ? raw.toUpperCase() : null;
}

export function readCookie(header, name = COOKIE) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

/** `maxAgeMs` null makes a browser-session cookie: gone when the browser closes. */
function sessionCookie(token, maxAgeMs) {
  return [
    `${COOKIE}=${token}`,
    `Path=${COOKIE_PATH}`,
    ...(maxAgeMs === null ? [] : [`Max-Age=${Math.floor(maxAgeMs / 1000)}`]),
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

function createLimiter(limit, windowMs, now) {
  const hits = new Map();
  return (key) => {
    const recent = (hits.get(key) || []).filter((stamp) => now() - stamp < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    hits.set(key, [...recent, now()]);
    return true;
  };
}

function maskMachineId(id) {
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function displayName(profile) {
  return [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() || (profile?.username ? `@${profile.username}` : "Пользователь Fetchr");
}

function maskHint(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Telegram";
  const prefix = raw.startsWith("@") ? "@" : "";
  const body = prefix ? raw.slice(1) : raw;
  if (body.length <= 2) return `${prefix}${body[0] || "*"}***`;
  return `${prefix}${body[0]}***${body.at(-1)}`;
}

function loginMessage({ code, machineId, ttlMs }) {
  return [
    "🔐 <b>Вход на fetchr.fun</b>",
    "",
    `Код: <code>${code}</code>`,
    "",
    `Устройство: <code>${maskMachineId(machineId)}</code>`,
    `Код действует ${Math.round(ttlMs / 60_000)} минут.`,
    "",
    "<i>Никому не сообщайте код. Если вход начали не вы — просто проигнорируйте сообщение.</i>",
  ].join("\n");
}

/** `readLicenses` / `readOrders` return the parsed JSONL records; `sendMessage`
 *  delivers HTML text to a Telegram chat through the bot. */
export function createAccount({ sessionsPath, readLicenses, readOrders, readGrants = async () => [], archiveProxy = null, emotes = null, checkout = null, appendLicense = async () => {}, sendMessage, lookupUser = async () => null, webLogins = null, botUrl = "https://t.me/fetchr_beta_bot", origins = ["https://fetchr.fun", "https://www.fetchr.fun"], now = () => Date.now(), log = () => {} }) {
  const pending = new Map();
  const sessions = loadSessions();

  const allowLoginIp = createLimiter(6, 10 * 60_000, now);
  const allowLoginMachine = createLimiter(3, 10 * 60_000, now);
  const allowVerifyIp = createLimiter(20, 10 * 60_000, now);
  const allowWebStartIp = createLimiter(10, 10 * 60_000, now);
  // The page polls every 2 s for up to 5 minutes.
  const allowWebPollIp = createLimiter(400, 10 * 60_000, now);

  function loadSessions() {
    if (!sessionsPath || !existsSync(sessionsPath)) return new Map();
    try {
      const list = JSON.parse(readFileSync(sessionsPath, "utf8"));
      return new Map(list.filter((item) => item?.hash && item.expires_at > now()).map((item) => [item.hash, item]));
    } catch (err) {
      log(`account: sessions file unreadable, starting empty: ${err.message}`);
      return new Map();
    }
  }

  function saveSessions() {
    if (!sessionsPath) return;
    mkdirSync(dirname(sessionsPath), { recursive: true });
    const tmp = `${sessionsPath}.tmp`;
    writeFileSync(tmp, JSON.stringify([...sessions.values()]), { mode: 0o600 });
    renameSync(tmp, sessionsPath);
  }

  function prune() {
    const stamp = now();
    for (const [id, request] of pending) if (request.expires_at <= stamp) pending.delete(id);
    let dropped = false;
    for (const [hash, session] of sessions) {
      if (session.expires_at <= stamp) {
        sessions.delete(hash);
        dropped = true;
      }
    }
    if (dropped) saveSessions();
  }

  /** Name and username come from Telegram when shown; they are not stored. */
  async function telegramProfile(userId) {
    try {
      return await lookupUser(userId);
    } catch (err) {
      log(`account: profile lookup failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Newest live registration of this Machine ID. */
  async function ownerOf(machineId) {
    const records = (await readLicenses()).filter((record) => String(record.machine_id || "").toUpperCase() === machineId);
    const latest = records.at(-1);
    if (!latest || latest.revoked_at || !latest.telegram_user_id) return null;
    return latest;
  }

  async function login(body, ip) {
    const machineId = normalizeMachineId(body?.machine_id);
    if (!machineId) throw new AccountError(400, "invalid_machine_id", "Machine ID — это 32 символа: цифры 0–9 и буквы A–F.");
    if (!allowLoginIp(ip)) throw new AccountError(429, "rate_limited", "Слишком много попыток. Подождите 10 минут.");
    prune();
    const owner = await ownerOf(machineId);
    if (!owner) {
      throw new AccountError(404, "not_registered", "Этот Machine ID не зарегистрирован. Получите ключ в боте — и возвращайтесь.");
    }
    if (!allowLoginMachine(machineId)) throw new AccountError(429, "rate_limited", "Код уже отправлен несколько раз. Подождите 10 минут.");

    for (const [id, request] of pending) if (request.machine_id === machineId) pending.delete(id);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const requestId = randomBytes(16).toString("hex");
    try {
      await sendMessage(owner.telegram_user_id, loginMessage({ code, machineId, ttlMs: CODE_TTL_MS }));
    } catch (err) {
      log(`account: code delivery to ${owner.telegram_user_id} failed: ${err instanceof Error ? err.message : err}`);
      throw new AccountError(502, "delivery_failed", "Бот не смог отправить код. Откройте бота, нажмите «Старт» и попробуйте снова.");
    }
    pending.set(requestId, {
      machine_id: machineId,
      user_id: owner.telegram_user_id,
      code_hash: sha256(`${requestId}:${code}`),
      attempts: 0,
      expires_at: now() + CODE_TTL_MS,
    });
    const telegram = await telegramProfile(owner.telegram_user_id);
    const hint = maskHint(telegram?.username ? `@${telegram.username}` : telegram?.first_name || "");
    return { request_id: requestId, expires_in: CODE_TTL_MS / 1000, hint };
  }

  function verify(body, ip) {
    if (!allowVerifyIp(ip)) throw new AccountError(429, "rate_limited", "Слишком много попыток. Подождите 10 минут.");
    prune();
    const requestId = String(body?.request_id || "");
    const code = String(body?.code || "").replace(/\s+/g, "");
    const request = pending.get(requestId);
    if (!request) throw new AccountError(410, "expired", "Код устарел. Запросите новый.");
    if (!/^\d{6}$/.test(code)) throw new AccountError(400, "invalid_code", "Код — это 6 цифр из сообщения бота.");
    request.attempts += 1;
    if (!sameHash(request.code_hash, sha256(`${requestId}:${code}`))) {
      if (request.attempts >= MAX_ATTEMPTS) {
        pending.delete(requestId);
        throw new AccountError(410, "expired", "Слишком много неверных попыток. Запросите новый код.");
      }
      throw new AccountError(401, "wrong_code", `Неверный код. Осталось попыток: ${MAX_ATTEMPTS - request.attempts}.`);
    }
    pending.delete(requestId);
    return openSession(request.user_id, request.machine_id, rememberOf(body));
  }

  /** Older pages send no flag and always got 30 days. */
  const rememberOf = (body) => body?.remember !== false;

  function openSession(userId, machineId, remember) {
    const token = randomBytes(32).toString("base64url");
    const stamp = now();
    const ttl = remember ? SESSION_TTL_MS : SHORT_SESSION_TTL_MS;
    sessions.set(sha256(token), {
      hash: sha256(token),
      user_id: userId,
      machine_id: machineId,
      remember,
      created_at: stamp,
      expires_at: stamp + ttl,
    });
    saveSessions();
    return { token, cookie: sessionCookie(token, remember ? SESSION_TTL_MS : null) };
  }

  function startWebLogin(req, ip) {
    if (!webLogins) throw new AccountError(503, "tg_login_off", "Вход через Telegram временно недоступен.");
    if (!allowWebStartIp(ip)) throw new AccountError(429, "rate_limited", "Слишком много попыток. Подождите 10 минут.");
    webLogins.sweep();
    const id = randomBytes(24).toString("base64url");
    const request = webLogins.open(id, { browser: describeBrowser(req.headers["user-agent"]), ip });
    return { id, url: `${botUrl}?start=${WEB_LOGIN_PREFIX}${id}`, expires_in: Math.round((request.expires_at - now()) / 1000) };
  }

  async function pollWebLogin(body, ip) {
    if (!webLogins) throw new AccountError(503, "tg_login_off", "Вход через Telegram временно недоступен.");
    if (!allowWebPollIp(ip)) throw new AccountError(429, "rate_limited", "Слишком много попыток. Подождите 10 минут.");
    const id = String(body?.id || "");
    const request = webLogins.read(id);
    if (!request) throw new AccountError(410, "expired", "Время на вход вышло. Нажмите «Войти через Telegram» ещё раз.");
    if (request.status === "pending") return { status: "pending" };
    webLogins.close(id);
    if (request.status !== "approved" || !request.user_id) {
      throw new AccountError(403, "denied", "Вход отменён в Telegram.");
    }
    const records = (await readLicenses()).filter((record) => record.telegram_user_id === request.user_id);
    // Reset keys expire after 30 days; a buyer's account lives on through orders.
    if (!records.length && !userOrders(await readOrders(), request.user_id).length) {
      throw new AccountError(404, "not_registered", "К этому Telegram не привязан аккаунт. Получите ключ в боте — и возвращайтесь.");
    }
    const device = liveDevices(records)[0];
    return openSession(request.user_id, device?.machine_id || "", rememberOf(body));
  }

  function sessionOf(req) {
    const token = readCookie(req.headers.cookie);
    if (!token || token.length > 128) return null;
    const session = sessions.get(sha256(token));
    if (!session || session.expires_at <= now()) return null;
    return session;
  }

  /** Live keys of this account, newest first. */
  function liveDevices(records) {
    const devices = new Map();
    for (const record of records) {
      const machineId = String(record.machine_id || "").toUpperCase();
      if (!machineId || !record.license_key) continue;
      if (record.revoked_at) devices.delete(machineId);
      else devices.set(machineId, { machine_id: machineId, license_key: record.license_key, issued_at: record.issued_at, record });
    }
    return [...devices.values()].sort((a, b) => String(b.issued_at).localeCompare(String(a.issued_at)));
  }

  /** When the next reset is allowed, from the revocations this account made. */
  function nextResetAt(records) {
    const last = records
      .filter((record) => record.revoked_at && record.revoked_by === "account")
      .map((record) => Date.parse(record.revoked_at))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    return last ? last + RESET_COOLDOWN_MS : 0;
  }

  async function profile(session) {
    const records = (await readLicenses()).filter((record) => record.telegram_user_id === session.user_id);
    const telegram = await telegramProfile(session.user_id);
    const orders = userOrders(await readOrders(), session.user_id);
    const resetAt = nextResetAt(records);
    return {
      user: {
        name: displayName(telegram),
        username: telegram?.username || null,
        telegram_id: session.user_id,
      },
      current_machine_id: session.machine_id,
      session_expires_at: new Date(session.expires_at).toISOString(),
      session_remembered: session.remember !== false,
      device_limit: 1,
      devices: liveDevices(records).map(({ record, ...device }) => device),
      next_reset_at: resetAt > now() ? new Date(resetAt).toISOString() : null,
      subscription: effectiveSubscription(
        subscriptionOf(orders, now()),
        grantSubscription(await readGrants(), await readLicenses(), session.user_id, now()),
      ),
      purchases: purchaseHistory(orders),
    };
  }

  async function resetDevice(session, body) {
    const machineId = normalizeMachineId(body?.machine_id);
    if (!machineId) throw new AccountError(400, "invalid_machine_id", "Неизвестное устройство.");
    const records = (await readLicenses()).filter((record) => record.telegram_user_id === session.user_id);
    const device = liveDevices(records).find((item) => item.machine_id === machineId);
    if (!device) throw new AccountError(404, "not_found", "Устройство уже сброшено или не ваше.");
    const resetAt = nextResetAt(records);
    if (resetAt > now()) {
      const when = new Date(resetAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
      throw new AccountError(429, "reset_cooldown", `Сбрасывать устройство можно раз в неделю. Следующий сброс — ${when}.`);
    }
    const stamp = new Date(now()).toISOString();
    await appendLicense({ ...device.record, revoked_at: stamp, revoked_by: "account" });
    await sendMessage(
      session.user_id,
      [
        "♻️ <b>Устройство сброшено</b>",
        "",
        `Ключ устройства <code>${maskMachineId(machineId)}</code> больше не действует.`,
        "Чтобы активировать Fetchr на новом компьютере, отправьте сюда его Machine ID.",
      ].join("\n"),
    ).catch((err) => log(`account: reset notice failed: ${err instanceof Error ? err.message : err}`));
    return profile(session);
  }

  function logout(session, everywhere) {
    if (everywhere) {
      for (const [hash, item] of sessions) if (item.user_id === session.user_id) sessions.delete(hash);
    } else {
      sessions.delete(session.hash);
    }
    saveSessions();
  }

  /** Browsers send Origin on POST; any other one is a cross-site request. */
  const sameOrigin = (req) => !req.headers.origin || origins.includes(String(req.headers.origin));

  const handle = async (req, res, url, { json, readJson }) => {
    if (!url.pathname.startsWith("/account/")) return false;
    const ip = String(req.headers["x-real-ip"] || req.socket.remoteAddress || "");
    try {
      // The Archive VPS page talks to the user's recorder through here: the
      // session cookie picks the recorder, and its token never reaches the browser.
      if (url.pathname.startsWith("/account/archive/")) {
        if (!["GET", "HEAD"].includes(req.method) && !sameOrigin(req)) {
          throw new AccountError(403, "forbidden", "Запрос с чужого сайта.");
        }
        const session = sessionOf(req);
        if (!session) throw new AccountError(401, "signed_out", "Войдите заново.");
        if (!archiveProxy) throw new AccountError(503, "archive_off", "Архив временно недоступен.");
        await archiveProxy(session.user_id, req, res, url.pathname.slice("/account/archive".length) + url.search);
        return true;
      }
      if (req.method === "POST") {
        if (!sameOrigin(req)) throw new AccountError(403, "forbidden", "Запрос с чужого сайта.");
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
          throw new AccountError(415, "json_only", "Ожидается JSON.");
        }
      }
      if (req.method === "POST" && url.pathname === "/account/login") {
        json(res, 200, await login(await readJson(req, 4096), ip));
        return true;
      }
      if (req.method === "POST" && url.pathname === "/account/verify") {
        const { cookie } = verify(await readJson(req, 4096), ip);
        res.setHeader("Set-Cookie", cookie);
        json(res, 200, { ok: true });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/account/tg/start") {
        json(res, 200, startWebLogin(req, ip));
        return true;
      }
      if (req.method === "POST" && url.pathname === "/account/tg/poll") {
        const result = await pollWebLogin(await readJson(req, 1024), ip);
        if (result.cookie) {
          res.setHeader("Set-Cookie", result.cookie);
          json(res, 200, { status: "ok" });
        } else {
          json(res, 200, result);
        }
        return true;
      }
      const session = sessionOf(req);
      if (req.method === "GET" && url.pathname === "/account/emotes") {
        if (!session) throw new AccountError(401, "signed_out", "Войдите заново.");
        res.setHeader("Cache-Control", "private, max-age=900");
        json(res, 200, emotes ? await emotes(url.searchParams.get("channel") || "") : {});
        return true;
      }
      if (req.method === "GET" && url.pathname === "/account/me") {
        if (!session) throw new AccountError(401, "signed_out", "Войдите заново.");
        json(res, 200, await profile(session));
        return true;
      }
      if (req.method === "POST" && (url.pathname === "/account/checkout" || url.pathname === "/account/checkout/quote")) {
        if (!session) throw new AccountError(401, "signed_out", "Войдите заново.");
        if (!checkout) throw new AccountError(503, "pay_off", "Оплата на сайте временно недоступна.");
        const body = await readJson(req, 1024);
        try {
          const result = url.pathname === "/account/checkout"
            ? await checkout.create(session.user_id, body)
            : await checkout.quote(session.user_id, body);
          json(res, 200, result);
        } catch (err) {
          if (Number.isInteger(err?.status) && err.code) throw new AccountError(err.status, err.code, err.message);
          throw err;
        }
        return true;
      }
      if (req.method === "POST" && url.pathname === "/account/device/reset") {
        if (!session) throw new AccountError(401, "signed_out", "Войдите заново.");
        json(res, 200, await resetDevice(session, await readJson(req, 1024)));
        return true;
      }
      if (req.method === "POST" && url.pathname === "/account/logout") {
        const body = await readJson(req, 1024);
        if (session) logout(session, Boolean(body?.everywhere));
        res.setHeader("Set-Cookie", sessionCookie("", 0));
        json(res, 200, { ok: true });
        return true;
      }
      json(res, 404, { error: "not_found" });
    } catch (err) {
      if (err instanceof AccountError) {
        json(res, err.status, { error: err.code, message: err.message });
      } else if (err instanceof SyntaxError || String(err?.message || "").includes("too large")) {
        json(res, 400, { error: "bad_request", message: "Некорректный запрос." });
      } else {
        log(`account: ${err instanceof Error ? err.stack || err.message : err}`);
        json(res, 500, { error: "internal_error", message: "Ошибка сервера. Попробуйте позже." });
      }
    }
    return true;
  };

  return { handle, login, verify, sessionOf, profile, resetDevice, logout };
}
