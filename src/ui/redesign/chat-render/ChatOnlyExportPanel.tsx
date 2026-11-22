import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { useTranslation } from "react-i18next";

import type { ChatMessageAnimation, ChatRenderQuality } from "@/types/job";
import styles from "./ChatRenderPage.module.css";
import { CHAT_SOURCE_PLACEHOLDER, ChatPlatformSelector, type ChatPlatform } from "./ChatPlatformSelector";

const MESSAGE_ANIMATION_OPTIONS: Array<{ value: ChatMessageAnimation; label: string; hint: string }> = [
  { value: "none", label: "Нет", hint: "Сообщение появляется сразу" },
  { value: "fade", label: "Проявление", hint: "Плавно проявляется на месте" },
  { value: "slide_up", label: "Снизу", hint: "Выезжает снизу и мягко раздвигает чат" },
  { value: "slide_left", label: "Слева", hint: "Въезжает слева, чат плавно сдвигается" },
  { value: "pop", label: "Поп", hint: "Выскакивает с лёгким перелётом" },
];

const RENDER_QUALITY_OPTIONS: Array<{ value: ChatRenderQuality; label: string }> = [
  { value: "standard", label: "720p" },
  { value: "high", label: "1080p" },
  { value: "ultra", label: "1440p" },
];

export interface ExportStatus {
  kind: "error" | "success" | "info";
  text: string;
}

interface ChatOnlyExportPanelProps {
  /** Простой режим: ссылка, диапазон, кадр и фон живут в верхней строке и автоматике. */
  simple?: boolean;
  /** Внутри инспектора: без шапки, статуса и кнопок — они есть в редакторе. */
  compact?: boolean;
  platform: ChatPlatform;
  sourceUrl: string;
  /** Channel a local chat JSON belongs to — the file itself may not name one. */
  channelHint: string;
  start: string;
  end: string;
  fileName: string;
  directory: string;
  busy: "json" | "render" | "queue" | null;
  status?: ExportStatus | null;
  startError?: string | null;
  endError?: string | null;
  previewLoading: boolean;
  frameError?: string | null;
  renderQuality: ChatRenderQuality;
  onRenderQualityChange: (value: ChatRenderQuality) => void;
  messageAnimation: ChatMessageAnimation;
  onMessageAnimationChange: (value: ChatMessageAnimation) => void;
  onPlatformChange: (platform: ChatPlatform) => void;
  onSourceUrlChange: (value: string) => void;
  onChannelHintChange: (value: string) => void;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onFileNameChange: (value: string) => void;
  onDirectoryChange: (value: string) => void;
  onChooseDirectory: () => void;
  /** Кнопка, которую нажали, — от неё стартует пилюля полёта в очередь */
  onDownloadJson: (origin: HTMLElement) => void;
  onRenderOnly: (origin: HTMLElement) => void;
  onAddToQueue: (origin: HTMLElement) => void;
  onChooseJsonFile: () => void;
  onUpdatePreview: () => void;
  onChooseBgImage: () => void;
  loadedPreviewCount?: number | null;
}

export function ChatOnlyExportPanel({
  simple = false,
  compact = false,
  platform,
  sourceUrl,
  channelHint,
  start,
  end,
  fileName,
  directory,
  busy,
  status,
  startError,
  endError,
  previewLoading,
  frameError,
  renderQuality,
  onRenderQualityChange,
  messageAnimation,
  onMessageAnimationChange,
  onPlatformChange,
  onSourceUrlChange,
  onChannelHintChange,
  onStartChange,
  onEndChange,
  onFileNameChange,
  onDirectoryChange,
  onChooseDirectory,
  onDownloadJson,
  onRenderOnly,
  onAddToQueue,
  onChooseJsonFile,
  onUpdatePreview,
  onChooseBgImage,
  loadedPreviewCount,
}: ChatOnlyExportPanelProps) {
  const { t } = useTranslation();
  const invalid = Boolean(startError || endError);
  const disabled = !sourceUrl.trim() || !fileName.trim() || !directory.trim() || Boolean(busy) || invalid;

  return (
    <section className={styles.panel}>
      {!compact && <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>{t("chat_render.parametry_eksporta", "Параметры экспорта")}</div>
        <RedesignIcon name="chat" />
      </div>}
      <div className={styles.panelBody}>
        <div className={styles.formGrid}>
          {!simple && <div style={{ display: "grid", gap: "var(--fetchr-space-3)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--fetchr-space-2)" }}>
              <button
                className={styles.button}
                type="button"
                onClick={onUpdatePreview}
                disabled={previewLoading || !sourceUrl.trim() || sourceUrl.toLowerCase().endsWith(".json")}
                title={sourceUrl.toLowerCase().endsWith(".json") ? "Кадр из видео недоступен для локального JSON" : "Получить кадр из Twitch/Kick трансляции"}
                style={{ display: "flex", gap: "8px", justifyContent: "center" }}
               aria-busy={previewLoading}>
                <RedesignIcon name={previewLoading ? "loading" : "preview"} className={previewLoading ? "animate-spin" : undefined} />
                <span>{t("chat_render.kadr_iz_vod", "Кадр из VOD")}</span>
              </button>
              <button
                className={styles.button}
                type="button"
                onClick={onChooseBgImage}
                disabled={previewLoading}
                title={t("chat_render.vybrat_lokalnoe_izobrazhenie_dlya_fona", "Выбрать локальное изображение для фона предпросмотра")}
                style={{ display: "flex", gap: "8px", justifyContent: "center" }}
              >
                <RedesignIcon name="image" />
                <span>Фон (картинка)</span>
              </button>
            </div>
            {loadedPreviewCount != null && loadedPreviewCount > 0 && (
              <div className={styles.statusLine} style={{ padding: "4px 8px", backgroundColor: "rgba(34, 197, 94, 0.1)", borderRadius: "4px", border: "1px solid rgba(34, 197, 94, 0.2)" }}>
                <span className={styles.success} style={{ fontSize: "12px", display: "flex", alignItems: "center", gap: "6px" }}>
                  <RedesignIcon name="check" className="size-3.5 text-green-500" />
                  Загружено {loadedPreviewCount} сообщений для предпросмотра
                </span>
              </div>
            )}
            {frameError && <div className={styles.error} style={{ fontSize: "11px", padding: "6px" }}>{frameError}</div>}
          </div>}

          {!compact && <ChatPlatformSelector value={platform} onChange={onPlatformChange} />}

          {!simple && <label className={styles.field}>
            <span className={styles.label}>Source URL / Локальный JSON</span>
            <div className={styles.twoColumn} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <span className={styles.iconField}>
                <RedesignIcon name="link" />
                <input
                  className={styles.mono}
                  value={sourceUrl}
                  placeholder={CHAT_SOURCE_PLACEHOLDER[platform]}
                  onChange={(event) => onSourceUrlChange(event.target.value)}
                />
              </span>
              <button
                className={`${styles.button} ${styles.iconButton}`}
                type="button"
                onClick={onChooseJsonFile}
                title={t("chat_render.vybrat_lokalnyy_json_fayl_chata", "Выбрать локальный JSON файл чата")}
              >
                <RedesignIcon name="exportJson" />
              </button>
            </div>
          </label>}

          {sourceUrl.toLowerCase().endsWith(".json") && (
            <label className={styles.field}>
              <span className={styles.label}>Канал (смайлы 7TV / BTTV / FFZ)</span>
              <input
                className={`${styles.input} ${styles.mono}`}
                value={channelHint}
                placeholder={platform === "twitch" ? "twitch-канал, напр. rachelr" : `${platform === "kick" ? "kick" : "w.tv"}-канал`}
                onChange={(event) => onChannelHintChange(event.target.value)}
              />
              <span className={styles.fieldHint}>
                Локальный JSON часто не хранит имя канала — без него смайлы 7TV/BTTV/FFZ
                остаются текстом.
              </span>
            </label>
          )}

          {!simple && <div className={styles.twoColumn}>
            <label className={styles.field}>
              <span className={styles.label}>{t("chat_render.nachalo", "Начало")}</span>
              <input
                className={`${styles.input} ${styles.mono} ${startError ? styles.inputInvalid : ""}`}
                value={start}
                placeholder="00:00:00"
                onChange={(event) => onStartChange(event.target.value)}
              />
              {startError && <span className={styles.fieldError}>{startError}</span>}
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t("chat_render.konec", "Конец")}</span>
              <input
                className={`${styles.input} ${styles.mono} ${endError ? styles.inputInvalid : ""}`}
                value={end}
                placeholder="00:00:00"
                onChange={(event) => onEndChange(event.target.value)}
              />
              {endError && <span className={styles.fieldError}>{endError}</span>}
            </label>
          </div>}

          <label className={styles.field}>
            <span className={styles.label}>{t("chat_render.imya_fayla", "Имя файла")}</span>
            <input className={styles.input} value={fileName} placeholder="stream_chat" onChange={(event) => onFileNameChange(event.target.value)} />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{t("chat_render.papka_sohraneniya", "Папка сохранения")}</span>
            <div className={styles.twoColumn} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <input className={`${styles.input} ${styles.mono}`} value={directory} onChange={(event) => onDirectoryChange(event.target.value)} />
              <button className={`${styles.button} ${styles.iconButton}`} type="button" onClick={onChooseDirectory} title={t("chat_render.vybrat_papku", "Выбрать папку")}>
                <RedesignIcon name="folder" />
              </button>
            </div>
          </label>

          {platform === "wtv" && !sourceUrl.toLowerCase().endsWith(".json") && (
            <div className={styles.warning}>
              W.TV не хранит чат прошедших трансляций. Чат пишется во время эфира: запись
              с w.tv/канал сохраняет рядом файл *_wtv_live_chat.json — его и откройте здесь.
            </div>
          )}


          {status && !compact && (
            <div
              className={
                status.kind === "error"
                  ? styles.error
                  : status.kind === "success"
                    ? styles.noticeSuccess
                    : styles.noticeInfo
              }
            >
              {status.text}
            </div>
          )}

          <div className={styles.segmentedWorkerPicker}>
            <span className={styles.label} title={t("chat_render.kachestvo_rasterizacii_chata_720p_kak", "Качество растеризации чата: 720p — как раньше; 1080p/1440p — чат рисуется в 1.5x/2x и при наложении на видео даунскейлится (чётче текст и смайлы). Отдельный рендер чата сохраняется в повышенном разрешении.")}>
              Качество рендера
            </span>
            <div className={styles.segmentedWorkerButtons}>
              {RENDER_QUALITY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`${styles.toggleButton} ${renderQuality === option.value ? styles.toggleButtonActive : ""}`}
                  onClick={() => onRenderQualityChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.segmentedWorkerPicker}>
            <span className={styles.label} title="Как новое сообщение появляется в чате. Анимация плавнее при высоком FPS чата.">
              Появление сообщений
            </span>
            <div className={styles.segmentedWorkerButtons}>
              {MESSAGE_ANIMATION_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={option.hint}
                  className={`${styles.toggleButton} ${messageAnimation === option.value ? styles.toggleButtonActive : ""}`}
                  onClick={() => onMessageAnimationChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* If the URL is a local JSON file, we disable the downloader action */}
          {!compact && (() => {
            const isLocalJson = sourceUrl.toLowerCase().endsWith(".json");
            return (
              <div className={styles.actionStack}>
                <button className={styles.button} type="button" onClick={(event) => onDownloadJson(event.currentTarget)} disabled={disabled || isLocalJson} aria-busy={busy === "json"}>
                  <RedesignIcon name={busy === "json" ? "loading" : "download"} className={busy === "json" ? "animate-spin" : undefined} />
                  Скачать JSON чата
                </button>
                <button className={`${styles.button} ${styles.primaryButton}`} type="button" onClick={(event) => onRenderOnly(event.currentTarget)} disabled={disabled} aria-busy={busy === "render"}>
                  <RedesignIcon name={busy === "render" ? "loading" : "play"} className={busy === "render" ? "animate-spin" : undefined} />
                  Рендерить только чат
                </button>
                <button className={styles.button} type="button" onClick={(event) => onAddToQueue(event.currentTarget)} disabled={disabled} aria-busy={busy === "queue"}>
                  <RedesignIcon name={busy === "queue" ? "loading" : "add"} className={busy === "queue" ? "animate-spin" : undefined} />
                  Добавить экспорт в очередь
                </button>
              </div>
            );
          })()}
        </div>
      </div>
    </section>
  );
}
