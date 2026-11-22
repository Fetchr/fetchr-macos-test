/** Тексты ролика. Всё, что видит зритель, — здесь, чтобы правка копирайта не требовала лезть в анимацию. */

export type NavId = "queue" | "live" | "vps" | "finder" | "chat" | "blur" | "mute" | "vocal" | "logs";

export const NAV: Array<{ id: NavId; label: string; icon: string }> = [
  { id: "queue", label: "Очередь", icon: "queue" },
  { id: "live", label: "Запись стримов", icon: "live" },
  { id: "vps", label: "Архив VPS", icon: "secure" },
  { id: "finder", label: "M3U8 Finder", icon: "finder" },
  { id: "chat", label: "Рендер чата", icon: "chat" },
  { id: "blur", label: "Блюр спонсоров", icon: "blur" },
  { id: "mute", label: "Удалить маты", icon: "audio" },
  { id: "vocal", label: "Vocal Remover", icon: "audio" },
  { id: "logs", label: "Логи", icon: "logs" },
];

export const POWER = {
  eyebrow: "И ещё",
  title: "Для тех, кто ценит скорость",
  items: [
    { key: "Ctrl K", label: "Командная палитра" },
    { key: "Пресеты", label: "Стримеры, чат и блюр в один клик" },
    { key: "Логи", label: "Видно каждый шаг пайплайна" },
  ],
} as const;

export const OUTRO = {
  title: ["От ссылки —", "до чистого исходника."],
  cta: "Скачать для Windows",
  meta: "Бесплатно · Windows 10 / 11 · fetchr.fun",
} as const;

/** Настоящие стримы из папки «Промо»: превью, названия и ссылки как в жизни */
export interface Stream {
  id: string;
  channel: string;
  title: string;
  url: string;
  platform: "twitch" | "youtube" | "kick" | "hls";
  source: string;
  image: string;
  thumb: string;
}

const media = (name: string) => `${import.meta.env.BASE_URL}media/${name}`;

export const STREAMS: Record<"leva" | "geo" | "xqc" | "hls" | "rostik", Stream> = {
  leva: {
    id: "leva",
    channel: "leva2k",
    title: "🚴‍♂️ВЕЛОТУР 2000км | #ТурДеАмстердам | !tg !donate !winline !ggsel",
    url: "https://www.twitch.tv/leva2k",
    platform: "twitch",
    source: "Twitch",
    image: media("s1.jpg"),
    thumb: media("s1-thumb.jpg"),
  },
  geo: {
    id: "geo",
    channel: "GEO",
    title: "БОМБА НА ШЕЕ. Самое безумное ограбление Америки | Расследование",
    url: "https://www.youtube.com/watch?v=cFja3yapEII",
    platform: "youtube",
    source: "YouTube",
    image: media("s2.jpg"),
    thumb: media("s2-thumb.jpg"),
  },
  xqc: {
    id: "xqc",
    channel: "xQc",
    title: "☘️LIVE☘️HERE☘️LOCK IN☘️DRAMA☘️NEWS☘️VIDEOS☘️GAMES☘️IMPORTANT☘️MEGA DAY☘️PUZZLE SOLVING☘️AND STUFF☘️ALERT☘️",
    url: "https://kick.com/xqc",
    platform: "kick",
    source: "Kick",
    image: media("s3.jpg"),
    thumb: media("s3-thumb.jpg"),
  },
  hls: {
    id: "hls",
    channel: "m3u8",
    title: "index-dvr.m3u8",
    url: "https://d1m7jfoe9zdc1j.cloudfront.net/…/chunked/index-dvr.m3u8",
    platform: "hls",
    source: "M3U8",
    image: media("s4.jpg"),
    thumb: media("s4-thumb.jpg"),
  },
  rostik: {
    id: "rostik",
    channel: "rostikfacekid",
    title: "TEAM AVICE vs team GPK bsb 180s delay w/ @avice",
    url: "https://www.twitch.tv/rostikfacekid",
    platform: "twitch",
    source: "Twitch",
    image: media("s5.jpg"),
    thumb: media("s5-thumb.jpg"),
  },
};

export const BANNER = media("banner.png");

/** Холодное открытие: сначала боль, потом глаголы на каждую долю */
export const PROBLEMS = ["Стрим закончился.", "VOD удалили.", "Реклама — прямо в кадре.", "А чат уже не вернуть."] as const;
export const VERBS = ["Скачать.", "Записать.", "Найти.", "Сохранить чат.", "Размыть рекламу.", "Убрать мат.", "Снять музыку."] as const;
export const HERO_TAGLINE = "Один инструмент для стримов и VOD";

/** Подписи сцен: где стоят и что говорят */
export const CAPTIONS = {
  queue: { eyebrow: "Очередь загрузок", title: ["Вставил ссылку —", "остальное само"] },
  threads: { eyebrow: "Twitch · YouTube · Kick · m3u8", title: ["До трёх потоков", "одновременно"] },
  finder: { eyebrow: "M3U8 Finder", title: ["Находит то,", "что уже удалили"] },
  live: { eyebrow: "Запись стримов", title: ["Эфир запишется,", "даже если вы спите"] },
  vps: { eyebrow: "Архив VPS", title: ["Пишет на сервере", "24/7, даже без ПК"] },
  plans: { eyebrow: "Подписка на архив", title: ["От 5 ГБ бесплатно", "до 1 ТБ истории"] },
  blur: { eyebrow: "Блюр спонсоров", title: ["Реклама", "размывается сама"] },
  chat: { eyebrow: "Рендер чата", title: ["Чат — прямо", "в кадре"] },
  mute: { eyebrow: "Fetchr Mute", title: ["Мат глушится", "по словарю"] },
  vocal: { eyebrow: "Vocal Remover", title: ["Никаких страйков", "за музыку"] },
  workspace: { eyebrow: "Рабочие пространства", title: ["Соберите интерфейс", "под себя"] },
} as const;

export type CaptionId = keyof typeof CAPTIONS;

/** Второй дроп: цифры на каждый такт */
export const STATS = [
  { value: "3", label: "платформы и любые m3u8" },
  { value: "24/7", label: "запись на сервере" },
  { value: "1440p", label: "рендер чата" },
  { value: "0", label: "ручной работы" },
] as const;

export const GAP_WORDS = ["Всё", "это —"] as const;
export const ONE_WINDOW = "одно окно.";
