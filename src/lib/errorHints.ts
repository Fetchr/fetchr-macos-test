/**
 * Что делать при частой ошибке загрузки — по тексту ошибки задачи.
 *
 * Правила взяты из реальных отчётов об ошибках (ноябрь 2026): сеть до Twitch,
 * прокси с паролем, cookies YouTube. Сама ошибка остаётся как есть — подсказка
 * показывается под ней. Нет подходящего правила — подсказки нет.
 */

interface HintRule {
  test: RegExp;
  hint: string;
}

const NETWORK_SETTINGS = "Настройки → Сеть и прокси";

const RULES: HintRule[] = [
  {
    test: /прокси требует|proxy authentication|407 proxy|proxy.*(auth|логин|password)/i,
    hint: `Прокси просит логин и пароль или не отвечает. Проверьте адрес в «${NETWORK_SETTINGS}» (формат socks5://логин:пароль@хост:порт) или выключите прокси и повторите.`, // secret-scan: allow
  },
  {
    test: /(could not (find|copy)|не (удалось|найден)).{0,40}cookie|cookies? (database|браузера)|sign in to confirm|не бот|просит (войти|подтвердить)/i,
    hint: "YouTube просит подтвердить, что вы не бот. Закройте браузер полностью — Chrome держит базу cookies открытой — и повторите загрузку.",
  },
  {
    test: /(twitch|gql\.twitch\.tv|ttvnw|usher).{0,120}(timed? ?out|таймаут|не отвечает|error sending request|failed to resolve|connection (reset|refused))|(timed? ?out|таймаут|не отвечает).{0,60}twitch/i,
    hint: `Twitch не отвечает — чаще всего мешает сеть. Смените сервер VPN или включите прокси в «${NETWORK_SETTINGS}», затем повторите задачу.`,
  },
  {
    test: /segment count check not pass|сегмент.{0,30}не (скачал|загрузил)/i,
    hint: "Часть сегментов не скачалась из-за обрыва связи. Повторите задачу — уже скачанное не потеряется.",
  },
  {
    test: /(kick\.com|kickvod).{0,80}(403|forbidden)|(403|forbidden).{0,80}kick/i,
    hint: "Kick закрыл доступ к записи: она удалена, скрыта или только для подписчиков. Если запись открывается в браузере — повторите через VPN.",
  },
  {
    test: /does not exist|video .{0,40}not found|видео (удалено|не найдено)|404 not found/i,
    hint: "Запись удалена или ссылка неверная. Проверьте, открывается ли она в браузере.",
  },
  {
    test: /no space left|недостаточно места|disk full/i,
    hint: "На диске закончилось место. Освободите место или выберите другую папку в настройках.",
  },
];

/** Подсказка к тексту ошибки задачи или null. Отмена — не ошибка. */
export function errorHint(error: string | null | undefined): string | null {
  const text = String(error ?? "").trim();
  if (!text || /^cancell?ed$/i.test(text)) return null;
  return RULES.find((rule) => rule.test.test(text))?.hint ?? null;
}
