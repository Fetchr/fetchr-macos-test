/** Raw backend/SSH error and a sentence a user can act on. */
export interface FriendlyError {
  message: string;
  detail: string;
}

const RULES: ReadonlyArray<{ test: RegExp; message: string }> = [
  // Fetchr archive (account server) — checked first: their texts also contain
  // words like «недоступен» that the SSH rules below would misread.
  {
    test: /нет оплаченного тарифа|no_subscription|нет тарифа|no.?plan/i,
    message: "На вашем аккаунте нет тарифа «Архив VPS». Выберите тариф на сайте — после оплаты архив подключится сам.",
  },
  {
    test: /не оплач|оплата не (прошла|найдена|поступила)|unpaid|payment.*(required|pending)|402/i,
    message: "Оплата ещё не поступила. Если вы только что оплатили, подождите минуту и нажмите «Уже оплатил».",
  },
  {
    test: /не найден или отозван|not_licensed|неизвестное устройство|другом аккаунте|аккаунт не совпадает|account.*mismatch/i,
    message: "Этот компьютер привязан к другому аккаунту, чем тот, где оплачен тариф. Активируйте Fetchr ключом из того же Telegram-аккаунта.",
  },
  { test: /сначала активируйте fetchr/i, message: "Сначала активируйте Fetchr ключом из бота, затем подключите архив." },
  {
    test: /сервер архива не принял доступ/i,
    message: "Сервер архива не принял доступ. Нажмите «Уже оплатил» в настройках сервера, чтобы получить его заново.",
  },
  {
    test: /сервер (архива|fetchr) (временно )?недоступен|непонятный ответ сервера fetchr|storage_unavailable/i,
    message: "Сервер архива Fetchr сейчас недоступен. Попробуйте через минуту.",
  },
  { test: /архив fetchr не подключён/i, message: "Архив Fetchr не подключён к этому компьютеру." },
  {
    test: /ключ сервера изменился/i,
    message: "Ключ сервера изменился. Если вы не переустанавливали VPS, это может быть подмена — подключение остановлено.",
  },
  {
    test: /неверный логин или пароль|отклонил вход|authentication failed|auth.*(fail|reject)/i,
    message: "Сервер не принял логин или пароль. Проверьте их в панели хостинга.",
  },
  {
    test: /аутентификации по ключу|прочитать ключ|key.*(invalid|decrypt|passphrase)/i,
    message: "Не подошёл SSH-ключ: проверьте файл ключа и его пароль.",
  },
  { test: /двухфакторн/i, message: "На сервере включена двухфакторная проверка — Fetchr так войти не может." },
  {
    test: /connection refused|отказано в подключении|actively refused|10061/i,
    message: "Сервер отвечает, но порт SSH закрыт. Проверьте порт и фаервол хостинга.",
  },
  {
    test: /timed out|timeout|тайм-?аут|превышено время|10060/i,
    message: "Сервер не ответил вовремя. Проверьте адрес и что VPS включён.",
  },
  {
    test: /no route|unreachable|недоступ|failed to lookup|name or service|resolve|dns|11001/i,
    message: "Сервер не найден по этому адресу. Проверьте IP или домен.",
  },
  {
    test: /no space left|нет места|disk full/i,
    message: "На сервере закончилось место. Освободите диск и повторите.",
  },
  { test: /нет systemd/i, message: "Эта система на сервере не подходит: нужен Linux с systemd (Ubuntu, Debian)." },
  {
    test: /apt-get|ffmpeg\/python3|venv/i,
    message: "Не удалось установить программы на сервер. Проверьте интернет на VPS и место на диске.",
  },
  { test: /хранилище паролей|сохранить пароль/i, message: "Windows не дала сохранить пароль. Повторите попытку." },
  { test: /vps не настроен/i, message: "Сервер ещё не добавлен." },
];

export function friendlyVpsError(err: unknown): FriendlyError {
  const detail = String((err as { message?: unknown } | null)?.message ?? err ?? "").trim();
  const rule = RULES.find((item) => item.test.test(detail));
  return {
    message: rule?.message ?? "Не удалось связаться с сервером.",
    detail,
  };
}
