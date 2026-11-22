import type { RedesignIconName } from "@/ui/redesign/icons/iconMap";

import type { QueueTaskUi } from "./taskUiTypes";

export interface TaskStage {
  id: "video" | "chat" | "render" | "blur" | "merge" | "asr" | "mute" | "vocal" | "rec";
  label: string;
  icon: RedesignIconName;
  /** Цвет отрезка на дорожке. */
  color: string;
  /** Доля длины дорожки: скачивание обычно самое долгое. */
  weight: number;
}

const STAGE: Record<TaskStage["id"], Omit<TaskStage, "id">> = {
  video: { label: "Скачивание", icon: "download", color: "#0a84ff", weight: 0.5 },
  chat: { label: "Чат", icon: "chat", color: "#bf5af2", weight: 0.1 },
  render: { label: "Рендер чата", icon: "media", color: "#2c9fbd", weight: 0.4 },
  blur: { label: "Блюр", icon: "blur", color: "#ff9f0a", weight: 0.4 },
  merge: { label: "Сборка", icon: "preview", color: "#8e8e93", weight: 0.08 },
  asr: { label: "Распознавание", icon: "vocal", color: "#bf5af2", weight: 0.6 },
  mute: { label: "Глушение", icon: "mute", color: "#2c9fbd", weight: 0.4 },
  vocal: { label: "Разделение", icon: "vocal", color: "#bf5af2", weight: 1 },
  rec: { label: "Запись эфира", icon: "live", color: "#ff453a", weight: 1 },
};

const stage = (id: TaskStage["id"]): TaskStage => ({ id, ...STAGE[id] });

/** Этапы задачи зависят от того, что к ней добавлено: чат, блюр, обработка звука. */
export function stagesFor(task: QueueTaskUi): TaskStage[] {
  if (task.live) return [stage("rec")];
  if (task.audioJob === "mute") return [stage("asr"), stage("mute")];
  if (task.audioJob === "vocal") return [stage("vocal")];
  if (task.chatOnly) return [stage("chat"), stage("render")];
  // Чат и блюр рендерятся одним проходом вместе со сборкой файла, поэтому это один этап.
  if (task.withChat) {
    const render = stage("render");
    return [stage("video"), stage("chat"), task.withBlur ? { ...render, label: "Рендер: чат и блюр" } : render];
  }
  if (task.withBlur) return [stage("video"), stage("blur")];
  return [stage("video")];
}

/** Какой этап идёт сейчас: по тексту стадии, а если он непонятен, по общему прогрессу. */
export function currentStage(task: QueueTaskUi, stages: TaskStage[]): number {
  const text = `${task.progressMessage ?? ""} ${task.statusDetail ?? ""}`.toLowerCase();
  // Тексты стадий приходят и по-русски, и в исходном английском виде из бэкенда.
  let wanted: TaskStage["id"] | null = null;
  if (/распозна|речь|transcrib|whisper|asr/.test(text)) wanted = "asr";
  // «Fetchr Mute» в названии стадии — имя модуля, а не этап глушения.
  else if (/глуш|тишин|сохранение файла|(?<!fetchr )mute/.test(text)) wanted = "mute";
  else if (/vocal|separat|разделение голоса|stems/.test(text)) wanted = "vocal";
  else if (/video-fps|chat-fps|chat pipe|direct render|direct compose|compos|rendering|render|рендер|отрисовк|кадр|qtrle/.test(text)) wanted = "render";
  else if (/наложени|сборк|склейк|объединени|merg|concat|mux|splitting/.test(text)) wanted = "merge";
  else if (/sponsor blur|размыти|блюр/.test(text)) wanted = "blur";
  else if (/чат|эмодзи|синхрониз|chat|emote|badge|normaliz/.test(text)) wanted = "chat";
  else if (/скачивани|сегмент|загрузк|download|fragment|segment/.test(text)) wanted = "video";
  // Сборка и блюр внутри рендера с чатом: отдельного отрезка у них нет.
  const aliases: Partial<Record<TaskStage["id"], TaskStage["id"]>> = { merge: "render", blur: "render" };
  let index = wanted ? stages.findIndex((item) => item.id === wanted) : -1;
  if (index < 0 && wanted && aliases[wanted]) index = stages.findIndex((item) => item.id === aliases[wanted]);
  if (index < 0 && wanted === "merge") index = stages.length - 1;
  if (index >= 0) return index;
  // Без подсказки в тексте: этап по общему проценту с учётом длины этапов.
  const at = (task.progress / 100) * totalWeight(stages);
  let edge = 0;
  for (let i = 0; i < stages.length; i += 1) {
    edge += stages[i].weight;
    if (at < edge) return i;
  }
  return stages.length - 1;
}

/** Заполненность текущего отрезка: процент стадии, если он есть, иначе доля от общего прогресса. */
export function stageFill(task: QueueTaskUi, index: number, stages: TaskStage[]): number {
  if (task.stagePercent != null && Number.isFinite(task.stagePercent)) {
    return Math.max(0, Math.min(100, task.stagePercent));
  }
  const total = totalWeight(stages);
  const start = stages.slice(0, index).reduce((sum, item) => sum + item.weight, 0) / total;
  const share = stages[index].weight / total;
  return Math.max(0, Math.min(100, ((task.progress / 100 - start) / share) * 100));
}

function totalWeight(stages: TaskStage[]): number {
  return stages.reduce((sum, item) => sum + item.weight, 0) || 1;
}
