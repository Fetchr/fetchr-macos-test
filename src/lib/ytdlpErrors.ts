/**
 * Понятные сообщения вместо сырого stderr yt-dlp и резолвера.
 *
 * Сырой текст не теряется: он уходит в `details`, чтобы показать его в
 * подсказке или раскрывающемся блоке — по нему разбираются в поддержке.
 */
export interface FriendlyError {
  message: string;
  /** Ключ перевода errors.<key>; null — сообщение взято из сырого текста. */
  key: string | null;
  /** Исходный текст ошибки; null, если он совпадает с сообщением. */
  details: string | null;
  /** Канал Twitch не в эфире: окну есть что подсказать дальше. */
  offline: boolean;
  /** Что пользователь может исправить сам: раздел настроек, куда вести. */
  action: ErrorAction | null;
}

export type ErrorAction = "proxy" | "twitch_auth" | "binaries";

interface Rule {
  key: string;
  test: RegExp;
  message: string;
  offline?: boolean;
  action?: ErrorAction;
}

const RULES: Rule[] = [
  {
    key: "ytdlp_missing",
    test: /yt-dlp(\.exe)? not found/i,
    message: "Не найден yt-dlp. Установи компоненты в настройках.",
    action: "binaries",
  },
  {
    key: "subscriber_only",
    test: /subscriber[- ]only|only available to subscribers|subscribe to .* to watch|requires a subscription/i,
    message: "Запись доступна только подписчикам канала. Добавь Twitch auth-token подписанного аккаунта в настройках интеграций.",
    action: "twitch_auth",
  },
  {
    key: "private_video",
    test: /private video|video is private|this video is private/i,
    message: "Видео приватное: автор открыл его только для избранных.",
  },
  {
    key: "members_only",
    test: /members[- ]only|join this channel to get access/i,
    message: "Видео только для спонсоров канала.",
  },
  {
    key: "age_restricted",
    test: /confirm your age|age[- ]restricted|inappropriate for some users/i,
    message: "Видео с возрастным ограничением. Войди в YouTube в браузере, чтобы Fetchr взял его cookies.",
  },
  {
    key: "bot_check",
    test: /sign in to confirm|not a bot/i,
    message: "YouTube просит подтвердить, что ты не бот. Войди в YouTube в браузере и попробуй ещё раз.",
  },
  {
    key: "geo_blocked",
    test: /not available in your country|blocked it in your country|geo[- ]?restrict|geo[- ]?block|not available from your location/i,
    message: "Видео недоступно в твоём регионе. Включи прокси в настройках.",
    action: "proxy",
  },
  {
    key: "proxy_failed",
    test: /proxy|tunnel connection failed|407 proxy/i,
    message: "Прокси не отвечает. Проверь адрес прокси в настройках или выключи его.",
    action: "proxy",
  },
  {
    key: "offline",
    test: /not currently live|is offline|channel is not live|stream is offline/i,
    message: "Канал сейчас не в эфире.",
    offline: true,
  },
  {
    key: "unavailable",
    test: /video unavailable|has been removed|no longer available|video does not exist|content isn.t available|has been deleted|this video is unavailable/i,
    message: "Видео недоступно: его удалили или скрыли.",
  },
  {
    key: "not_found",
    test: /http error 404|404: not found|\b404\b/i,
    message: "По ссылке ничего нет (ошибка 404). Проверь, что ссылка скопирована целиком.",
  },
  {
    key: "forbidden",
    test: /http error 403|403: forbidden/i,
    message: "Сервер отказал в доступе (ошибка 403). Попробуй прокси или обнови yt-dlp.",
    action: "proxy",
  },
  {
    key: "rate_limited",
    test: /http error 429|too many requests/i,
    message: "Слишком много запросов. Подожди пару минут и попробуй снова.",
  },
  {
    key: "unsupported_url",
    test: /unsupported url/i,
    message: "Эта ссылка не поддерживается. Вставь ссылку на канал, запись, клип или видео.",
  },
  {
    key: "network",
    test: /getaddrinfo|timed out|connection refused|network is unreachable|failed to resolve|no route to host/i,
    message: "Нет связи с сервером. Проверь интернет или прокси.",
  },
];

/** Первая строка «ERROR: …» без служебных префиксов: короче и читаемее. */
function shortRaw(raw: string): string {
  const errorLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^error:/i.test(line));
  const line = errorLine ?? raw.trim().split(/\r?\n/)[0] ?? raw;
  return line
    .replace(/^(error:\s*)+/i, "")
    .replace(/^yt-dlp( -g)? failed( after trying browser cookies)?:\s*/i, "")
    .replace(/^error:\s*/i, "")
    .replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, "")
    .trim();
}

export function friendlyError(reason: unknown): FriendlyError {
  const raw = (reason instanceof Error ? reason.message : String(reason ?? "")).trim();
  if (!raw) return { message: "Неизвестная ошибка.", key: "unknown", details: null, offline: false, action: null };
  const rule = RULES.find((item) => item.test.test(raw));
  if (rule) return { message: rule.message, key: rule.key, details: raw, offline: Boolean(rule.offline), action: rule.action ?? null };
  const short = shortRaw(raw) || raw;
  return { message: short, key: null, details: short === raw ? null : raw, offline: false, action: null };
}

export const formatYtdlpError = friendlyError;
