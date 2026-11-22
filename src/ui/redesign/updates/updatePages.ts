import type { UpdatePage, UpdateStatus } from "@/lib/ipc";

export type UpdateCategory = "download" | "queue" | "chat" | "blur" | "mute" | "vocal" | "archive" | "live" | "general";

export const CATEGORY_TITLE: Record<UpdateCategory, string> = {
  download: "Скачивание",
  queue: "Загрузки",
  chat: "Рендер чата",
  blur: "Блюр спонсоров",
  mute: "Удаление матов",
  vocal: "Vocal Remover",
  archive: "Архив VPS",
  live: "Запись эфира",
  general: "Общее",
};

const KEYWORDS: Array<[UpdateCategory, RegExp]> = [
  ["mute", /мат|mute|цензур|swear|profan/i],
  ["vocal", /vocal|вокал|музык|стем|ап\b|copyright|music/i],
  ["blur", /блюр|blur|спонсор|sponsor/i],
  ["chat", /чат|chat/i],
  ["archive", /архив|vps|archive/i],
  ["live", /эфир|запис[ьи] стрим|live|recorder/i],
  ["queue", /загрузк|очеред|queue|прогресс/i],
  ["download", /скача|download|ссылк|vod|m3u8/i],
];

export interface ShownPage {
  category: UpdateCategory;
  title: string;
  items: string[];
  media: string | null;
}

function categoryOf(text: string): UpdateCategory {
  return KEYWORDS.find(([, re]) => re.test(text))?.[0] ?? "general";
}

function normalizeCategory(value: string | null | undefined, fallbackText: string): UpdateCategory {
  if (value && value in CATEGORY_TITLE) return value as UpdateCategory;
  return categoryOf(`${value ?? ""} ${fallbackText}`);
}

/**
 * Страницы окна «Что нового». Если в манифесте есть готовые страницы —
 * берём их; иначе раскладываем пункты из заметок по категориям, по одной
 * странице на категорию, с первой страницей-обзором.
 */
export function buildPages(status: UpdateStatus, language: string, notes: string | null): ShownPage[] {
  const lang = language.split("-")[0];
  const given: UpdatePage[] | undefined = status.pages_i18n?.[language] ?? status.pages_i18n?.[lang] ?? status.pages_i18n?.ru;
  if (given && given.length > 0) {
    return given.map((page) => ({
      category: normalizeCategory(page.category, `${page.title} ${page.items.join(" ")}`),
      title: page.title,
      items: page.items,
      media: page.media,
    }));
  }

  const lines = (notes ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headline = lines.length > 0 && !/^[-*•]/.test(lines[0]) ? lines.shift() : null;
  const items = lines.map((line) => line.replace(/^[-*•\d.]+\s*/, "")).filter(Boolean);

  const groups = new Map<UpdateCategory, string[]>();
  for (const item of items) {
    const category = categoryOf(item);
    groups.set(category, [...(groups.get(category) ?? []), item]);
  }

  const intro: ShownPage = {
    category: "general",
    title: headline ?? `Fetchr ${status.version ?? ""}`.trim(),
    items: items.length > 0 ? [`${items.length} изменений в ${groups.size} разделах — листайте, чтобы посмотреть каждый.`] : [],
    media: null,
  };
  const pages = [...groups.entries()]
    .sort(([a], [b]) => (a === "general" ? 1 : b === "general" ? -1 : 0))
    .map(([category, list]) => ({ category, title: CATEGORY_TITLE[category], items: list, media: null }));
  return pages.length > 1 ? [intro, ...pages] : pages.length === 1 ? [{ ...pages[0], title: intro.title }] : [intro];
}
