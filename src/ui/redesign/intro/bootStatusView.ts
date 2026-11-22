import type { TFunction } from "i18next";

import type { BootPhase, BootTaskState } from "@/stores/boot";
import type { UpdateStage } from "@/stores/updater";

import { formatEta, formatPercent, formatSize, formatSpeed } from "./bootFormat";

export type StatusTone = "accent" | "success" | "danger";

export interface StatusView {
  /** Проверки и обновление — разные рейки: при смене заливка не едет назад */
  track: "checks" | "update";
  tone: StatusTone;
  label: string;
  /** Версия рядом с этапом: отдельно, чтобы uppercase этапа её не трогал */
  version: string | null;
  /** 0…1; null — объём неизвестен, остаётся только бегущий блик */
  progress: number | null;
  busy: boolean;
  start: string;
  end: string;
  detail: string | null;
  actions: "later" | "failed" | null;
}

export interface StatusInput {
  phase: BootPhase;
  licenseTask: BootTaskState;
  licenseActive: boolean;
  updateTask: BootTaskState;
  stage: UpdateStage;
  version: string | null;
  received: number;
  total: number | null;
  bytesPerSecond: number;
  installError: string | null;
}

export function describeStatus(input: StatusInput, t: TFunction, locale: string): StatusView {
  return input.phase === "updating" ? describeUpdate(input, t, locale) : describeChecks(input, t);
}

function describeChecks(input: StatusInput, t: TFunction): StatusView {
  const tasks = [input.licenseTask, input.updateTask];
  const done = tasks.filter((task) => task !== "pending").length;
  const progress = done / tasks.length;
  const finished = done === tasks.length;
  const label =
    input.licenseTask === "pending"
      ? t("boot.stage.license")
      : input.updateTask === "pending"
        ? t("boot.stage.updates")
        : input.licenseActive
          ? t("boot.stage.ready")
          : t("boot.stage.activation");
  return {
    track: "checks",
    tone: finished && input.licenseActive ? "success" : "accent",
    label,
    version: null,
    progress,
    busy: done < tasks.length,
    start: formatPercent(progress),
    end: __APP_VERSION__,
    detail: null,
    actions: null,
  };
}

function describeUpdate(input: StatusInput, t: TFunction, locale: string): StatusView {
  const version = input.version?.trim().replace(/^v/i, "");
  const base: StatusView = {
    track: "update",
    tone: "accent",
    label: t("boot.stage.download"),
    version: version ? `v${version}` : null,
    progress: 0,
    busy: true,
    start: formatPercent(0),
    end: "",
    detail: t("boot.detail.preparing"),
    actions: "later",
  };

  switch (input.stage) {
    case "downloading": {
      const fraction = input.total ? input.received / input.total : null;
      const size = input.total
        ? t("boot.detail.size", {
            received: formatSize(input.received, t, locale),
            total: formatSize(input.total, t, locale),
          })
        : formatSize(input.received, t, locale);
      const eta =
        input.total && input.bytesPerSecond > 0
          ? formatEta((input.total - input.received) / input.bytesPerSecond, t)
          : null;
      return {
        ...base,
        progress: fraction,
        busy: fraction === null,
        start: fraction === null ? "" : formatPercent(fraction),
        end: formatSpeed(input.bytesPerSecond, t, locale),
        detail: eta ? `${size} · ${t("boot.detail.eta", { time: eta })}` : size,
      };
    }
    case "verifying":
      return {
        ...base,
        label: t("boot.stage.verify"),
        progress: 1,
        start: formatPercent(1),
        detail: t("boot.detail.verify"),
        actions: null,
      };
    case "installing":
      return {
        ...base,
        tone: "success",
        label: t("boot.stage.install"),
        progress: 1,
        start: formatPercent(1),
        detail: t("boot.detail.restart"),
        actions: null,
      };
    case "failed":
      return {
        ...base,
        tone: "danger",
        label: t("boot.stage.failed"),
        progress: input.total ? input.received / input.total : 0,
        busy: false,
        start: "",
        detail: input.installError ?? t("boot.detail.failed"),
        actions: "failed",
      };
    default:
      return base;
  }
}
