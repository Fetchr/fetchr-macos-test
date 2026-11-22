import type { RedesignIconName } from "@/ui/redesign/icons/iconMap";
import type { AppNavigationItemId } from "@/ui/redesign/topbar/navigationTypes";

/** Что докачивает мастер: id совпадают с командой setup_install_component */
export type SetupComponent = "ffmpeg" | "tracker" | "asr" | "vocal";

export interface SetupTool {
  id: AppNavigationItemId;
  icon: RedesignIconName;
  components: SetupComponent[];
  /** Без очереди приложение не работает — её не выключить */
  locked?: boolean;
}

export const SETUP_TOOLS: SetupTool[] = [
  { id: "queue", icon: "queue", components: ["ffmpeg"], locked: true },
  { id: "live-recorder", icon: "live", components: ["ffmpeg"] },
  { id: "finder", icon: "finder", components: ["ffmpeg"] },
  { id: "chat-render", icon: "chat", components: ["ffmpeg"] },
  { id: "sponsor-blur", icon: "blur", components: ["ffmpeg", "tracker"] },
  { id: "fetchr-mute", icon: "audio", components: ["ffmpeg", "asr"] },
  { id: "vocal-remover", icon: "audio", components: ["ffmpeg", "vocal"] },
];

/** Порядок установки: лёгкое сначала, тяжёлые модели в конце */
const COMPONENT_ORDER: SetupComponent[] = ["ffmpeg", "tracker", "vocal", "asr"];

const SELECTABLE = new Set<string>(SETUP_TOOLS.map((tool) => tool.id));

/**
 * Показывать ли вкладку. Выбор мастера касается только его инструментов:
 * логи, настройки и архив VPS живут по своим правилам.
 */
export function isToolEnabled(enabled: readonly string[] | null, id: string): boolean {
  if (!enabled || !SELECTABLE.has(id)) return true;
  return enabled.includes(id) || SETUP_TOOLS.some((tool) => tool.id === id && tool.locked);
}

export function componentsFor(toolIds: readonly string[]): SetupComponent[] {
  const needed = new Set(
    SETUP_TOOLS.filter((tool) => toolIds.includes(tool.id)).flatMap((tool) => tool.components),
  );
  return COMPONENT_ORDER.filter((component) => needed.has(component));
}
