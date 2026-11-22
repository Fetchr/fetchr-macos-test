import type { FetchrMuteSettings, JobSpec } from "@/types/job";

import { isSupportedMediaPath } from "./constants";
import { fileNameFromPath } from "./fetchrMuteSettings";

/** Файл пакетной обработки: путь, имя и размер (null — ещё не узнали или не прочитать). */
export interface BatchFile {
  path: string;
  name: string;
  size: number | null;
}

/** Куда отправить выбранные или брошенные файлы. */
export type PathRoute = "none" | "single" | "batch";

export function partitionMediaPaths(paths: string[]): { supported: string[]; skipped: number } {
  const supported = paths.filter(isSupportedMediaPath);
  return { supported, skipped: paths.length - supported.length };
}

/**
 * Один файл — прежний одиночный сценарий; два и больше — пакет. Пока пакет
 * открыт, любые новые файлы добавляются в него.
 */
export function routeMediaPaths(supportedCount: number, batchSize: number): PathRoute {
  if (supportedCount === 0) return "none";
  if (batchSize > 0 || supportedCount > 1) return "batch";
  return "single";
}

const pathKey = (path: string) => path.replaceAll("/", "\\").toLowerCase();

/** Новые файлы для пакета: без тех, что уже в списке, и без повторов. */
export function newBatchFiles(existing: BatchFile[], paths: string[]): BatchFile[] {
  const seen = new Set(existing.map((file) => pathKey(file.path)));
  return paths.flatMap((path) => {
    const key = pathKey(path);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ path, name: fileNameFromPath(path), size: null }];
  });
}

export function parentDir(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut) : "";
}

interface BatchJobOptions {
  path: string;
  settings: FetchrMuteSettings;
  /** Своя папка результатов; null — рядом с каждым исходником. */
  outputDir: string | null;
  binariesDir: string | null;
}

/**
 * Задача очереди «Удалить маты» над локальным файлом. Дорожка — по умолчанию:
 * у файлов пакета она своя у каждого.
 */
export function buildBatchJobSpec({ path, settings, outputDir, binariesDir }: BatchJobOptions): JobSpec {
  const name = fileNameFromPath(path);
  return {
    url: path,
    name,
    directory: outputDir ?? parentDir(path),
    job_kind: "fetchrmute",
    mode: "vod",
    proxy: { enabled: false, url: "" },
    binaries_dir: binariesDir,
    fetchr_mute_enabled: true,
    fetchr_mute_model: settings.asr_model,
    fetchr_mute_settings: { ...settings, audio_track_index: null },
    fetchr_mute_output_dir: outputDir,
    meta: { title: name, platform: "local" },
  };
}
