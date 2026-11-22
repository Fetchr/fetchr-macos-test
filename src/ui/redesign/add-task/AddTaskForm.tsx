import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Quality, ResolvedStream, VideoCodecPolicy } from "@/types/job";
import { formatBytes } from "@/lib/format";
import { formatYtdlpError } from "@/lib/ytdlpErrors";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";
import { Select } from "@/components/ui/select";

import styles from "./AddTaskModal.module.css";
import { AddTaskPresetSummary } from "./AddTaskPresetSummary";
import { TimecodeRangeList, type TimecodeRange } from "./TimecodeRangeList";
import type { AddTaskSource } from "./SourceTabs";

export interface AddTaskFormProps {
  activeSource: AddTaskSource;
  sourceUrl: string;
  fileName: string;
  quality: string;
  codecPolicy: VideoCodecPolicy;
  downloadFolder: string;
  start: string;
  end: string;
  ranges: TimecodeRange[];
  downloadChatEnabled: boolean;
  sponsorBlurEnabled: boolean;
  fetchrMuteEnabled: boolean;
  unmuteVideoEnabled: boolean;
  analyzing: boolean;
  error: string | null;
  resolved: ResolvedStream | null;
  previewUrl: string | null;
  previewEmbedUrl: string | null;
  previewLoading: boolean;
  previewError: string | null;
  sourceLabel: string;
  qualityOptions: Quality[];
  m3u8VideoOnly: boolean;
  chatPresets: Array<{ id: string; name: string }>;
  activeChatPresetId: string;
  sponsorBlurPresets: Array<{ id: string; name: string }>;
  activeSponsorPresetId: string;
  onSourceUrlChange: (value: string) => void;
  onFileNameChange: (value: string) => void;
  onQualityChange: (value: string) => void;
  onDownloadFolderChange: (value: string) => void;
  onChooseFolder: () => void;
  onAnalyze: () => void;
  onDownloadChatChange: (value: boolean) => void;
  onChatPresetChange: (presetId: string) => void;
  onSponsorBlurChange: (value: boolean) => void;
  onSponsorPresetChange: (presetId: string) => void;
  onConfigureBlur: () => void;
  onFetchrMuteChange: (value: boolean) => void;
  onUnmuteVideoChange: (value: boolean) => void;
  onChooseLocalFile: () => void;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onAddRange: () => void;
  onUpdateRange: (id: string, patch: Partial<Pick<TimecodeRange, "start" | "end">>) => void;
  onRemoveRange: (id: string) => void;
  onOpenChannelVods?: () => void;
  onOpenLiveRecorder?: () => void;
}

export function AddTaskForm({
  activeSource,
  sourceUrl,
  fileName,
  quality,
  codecPolicy,
  downloadFolder,
  start,
  end,
  ranges,
  downloadChatEnabled,
  sponsorBlurEnabled,
  fetchrMuteEnabled,
  unmuteVideoEnabled,
  analyzing,
  error,
  resolved,
  previewUrl,
  previewEmbedUrl,
  previewLoading,
  previewError,
  sourceLabel,
  qualityOptions,
  m3u8VideoOnly,
  chatPresets,
  activeChatPresetId,
  sponsorBlurPresets,
  activeSponsorPresetId,
  onSourceUrlChange,
  onFileNameChange,
  onQualityChange,
  onDownloadFolderChange,
  onChooseFolder,
  onAnalyze,
  onDownloadChatChange,
  onChatPresetChange,
  onSponsorBlurChange,
  onSponsorPresetChange,
  onConfigureBlur,
  onFetchrMuteChange,
  onUnmuteVideoChange,
  onChooseLocalFile,
  onStartChange,
  onEndChange,
  onAddRange,
  onUpdateRange,
  onRemoveRange,
  onOpenChannelVods,
  onOpenLiveRecorder,
}: AddTaskFormProps) {
  const { t } = useTranslation();
  const errorInfo = error ? formatYtdlpError(error) : null;

  const qualityLabel =
    quality === "best"
      ? t("add.quality_best_original", "Лучшее")
      : qualityOptions.find((item) => item.id === quality)?.label ?? quality;
  // YouTube downloads are plain video: none of the Twitch-oriented post-steps
  // apply. A raw m3u8 has no chat feed to fetch either.
  const showChatToggle = activeSource !== "youtube" && activeSource !== "m3u8";
  const showExtraSettings = activeSource !== "youtube";
  const transportLabel = isTwitchVodSource(sourceUrl)
    ? t("add.twitch_vod_chat_info", "Видео: m3u8/HLS · Чат: Twitch VOD")
    : m3u8VideoOnly
      ? t("add.m3u8_no_chat_info", "Видео: m3u8/HLS · Чат: недоступен")
      : null;

  return (
    <div className={styles.grid}>
      <div className={styles.formColumn}>
        <div className={styles.inputsGroup}>
          <section className={`${styles.section} ${styles.sourceSection}`}>
            <div className={styles.fieldRow}>
              {activeSource === "local" ? (
                <div className={styles.inputContainer}>
                  <RedesignIcon name="media" />
                  <input
                    className={styles.inputTransparent}
                    value={sourceUrl}
                    placeholder={t("add.choose_file_placeholder", "Выберите аудио или видео файл...")}
                    readOnly
                  />
                  <button
                    className={styles.inputInnerButton}
                    type="button"
                    onClick={onChooseLocalFile}
                    title={t("add.choose_file", "Выбрать файл")}
                  >
                    <RedesignIcon name="folder" className="size-4" />
                  </button>
                </div>
              ) : (
                <div className={styles.inputContainer}>
                  <RedesignIcon name="link" />
                  <input
                    className={styles.inputTransparent}
                    value={sourceUrl}
                    onChange={(event) => onSourceUrlChange(event.currentTarget.value)}
                    placeholder="https://www.twitch.tv/username..."
                  />
                  <button
                    className={styles.inputInnerButton}
                    type="button"
                    onClick={onAnalyze}
                    disabled={!sourceUrl.trim() || analyzing}
                    title={t("add.analyze", "Проанализировать")}
                    aria-busy={analyzing}
                  >
                    <RedesignIcon name={analyzing ? "loading" : "finder"} className={analyzing ? "size-4 animate-spin" : "size-4"} />
                  </button>
                </div>
              )}
            </div>

            {errorInfo && (
              <div className={styles.error} title={errorInfo.details ?? undefined}>
                <div>{errorInfo.message}</div>
                {errorInfo.offline && activeSource === "twitch" && (
                  <div className={styles.errorActions}>
                    <span className={styles.errorHint}>
                      Чтобы скачать прошлые трансляции или поставить автозапись при старте эфира:
                    </span>
                    <div className={styles.errorActionButtons}>
                      {onOpenChannelVods && (
                        <button type="button" className={styles.button} onClick={onOpenChannelVods}>
                          <RedesignIcon name="media" className="size-3.5" />
                          Записи канала (VOD)
                        </button>
                      )}
                      {onOpenLiveRecorder && (
                        <button type="button" className={styles.button} onClick={onOpenLiveRecorder}>
                          <RedesignIcon name="live" className="size-3.5" />
                          Запись стримов
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {errorInfo.details && (
                  <details className={styles.errorDetails}>
                    <summary>Технические детали</summary>
                    <pre>{errorInfo.details}</pre>
                  </details>
                )}
              </div>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.compactFields}>
              <label className={styles.compactField}>
                <input
                  className={styles.input}
                  value={fileName}
                  onChange={(event) => onFileNameChange(event.currentTarget.value)}
                  placeholder={t("add.filename_placeholder", "Имя файла без расширения")}
                />
              </label>

              {activeSource !== "local" && (
                <>
                  <label className={styles.compactField}>
                    <div className={styles.qualityRow}>
                      <Select className={styles.select} value={quality} onValueChange={(value) => onQualityChange(value)}>
                        <option value="best">{t("add.quality_best_original", "Лучшее")}</option>
                        {groupQualityOptions(qualityOptions).map(([group, items]) => (
                          <optgroup key={group} label={qualityGroupLabel(group, t)}>
                            {items.map((item) => (
                              <option key={item.id} value={item.id}>
                                {formatQuality(item, t, codecPolicy)}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </Select>
                    </div>
                  </label>

                  <div className={`${styles.iconField} ${styles.folderField}`}>
                    <RedesignIcon name="folder" />
                    <input
                      value={downloadFolder}
                      onChange={(event) => onDownloadFolderChange(event.currentTarget.value)}
                      placeholder="C:\Users\..."
                      aria-label={t("add.directory", "Папка")}
                    />
                    <button
                      className={styles.iconFieldAction}
                      type="button"
                      aria-label={t("add.choose_directory", "Выбрать папку")}
                      title={t("add.choose_directory", "Выбрать папку")}
                      onClick={onChooseFolder}
                    >
                      <RedesignIcon name="more" className="size-4" />
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>

          {activeSource !== "local" && (
            <section className={styles.section}>
              <TimecodeRangeList
                start={start}
                end={end}
                ranges={ranges}
                onStartChange={onStartChange}
                onEndChange={onEndChange}
                onAddRange={onAddRange}
                onUpdateRange={onUpdateRange}
                onRemoveRange={onRemoveRange}
              />
            </section>
          )}
        </div>

        {activeSource === "local" ? (
          <section className={styles.togglesSection}>
            <div className={styles.options}>
              <OptionRow
                icon="audio"
                label={t("add.fetchr_mute", "Очистить от матов (Fetchr Mute)")}
                checked={fetchrMuteEnabled}
                onChange={onFetchrMuteChange}
              />
            </div>
          </section>
        ) : showExtraSettings ? (
          <section className={styles.togglesSection}>
            <div className={styles.options}>
              {showChatToggle && (
                <OptionRow
                  icon="chat"
                  label={t("add.download_chat", "Добавить чат")}
                  checked={downloadChatEnabled}
                  onChange={onDownloadChatChange}
                >
                  <Select
                    className={styles.optionSelect}
                    value={activeChatPresetId}
                    onValueChange={(value) => onChatPresetChange(value)}
                    disabled={!downloadChatEnabled || chatPresets.length === 0}
                    aria-label={t("add.chat_preset", "Пресет чата")}
                  >
                    {chatPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </Select>
                </OptionRow>
              )}

              <OptionRow
                icon="blur"
                label={t("add.sponsor_blur", "Блюр спонсоров")}
                checked={sponsorBlurEnabled}
                onChange={onSponsorBlurChange}
              >
                <Select
                  className={styles.optionSelect}
                  value={activeSponsorPresetId}
                  onValueChange={(value) => onSponsorPresetChange(value)}
                  disabled={!sponsorBlurEnabled || sponsorBlurPresets.length === 0}
                  aria-label={t("add.blur_preset", "Пресет блюра")}
                >
                  {sponsorBlurPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </Select>
                <button className={styles.optionButton} type="button" onClick={onConfigureBlur}>
                  <RedesignIcon name="settings" />
                  {t("add.configure_blur", "Настроить блюр")}
                </button>
              </OptionRow>

              <OptionRow
                icon="audio"
                label={t("add.fetchr_mute", "Очистить от матов (Fetchr Mute)")}
                checked={fetchrMuteEnabled}
                onChange={onFetchrMuteChange}
              />

              <OptionRow
                icon="audio"
                label={t("add.unmute_video", "Вернуть звук (заглушённое на Twitch)")}
                checked={unmuteVideoEnabled}
                onChange={onUnmuteVideoChange}
              />
            </div>
          </section>
        ) : null}
      </div>

      <div className={styles.previewColumn}>
        <AddTaskPresetSummary
          sourcePlatform={activeSource === "m3u8" ? "hls" : activeSource}
          sourceLabel={sourceLabel}
          qualityLabel={qualityLabel}
          transportLabel={transportLabel}
          folder={downloadFolder}
          sponsorBlurEnabled={sponsorBlurEnabled}
          rangeCount={ranges.length}
          resolved={resolved}
          previewUrl={previewUrl}
          previewEmbedUrl={previewEmbedUrl}
          previewLoading={previewLoading}
          previewError={previewError}
          onMarkStart={onStartChange}
          onMarkEnd={onEndChange}
        />
      </div>
    </div>
  );
}

/**
 * Строка опции задачи из промо: галочка, иконка и подпись — один label,
 * пресет и «Настроить» справа — вне его, чтобы клик по ним не переключал
 * галочку.
 */
function OptionRow({
  icon,
  label,
  checked,
  onChange,
  children,
}: {
  icon: RedesignIconName;
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className={styles.optionRow}>
      <label className={styles.optionMain}>
        <input
          className={styles.check}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <RedesignIcon name={icon} className={styles.optionIcon} />
        <span>{label}</span>
      </label>
      {children}
    </div>
  );
}

function isTwitchVodSource(input: string): boolean {
  return /(?:^https?:\/\/)?(?:www\.)?twitch\.tv\/(?:videos|video|v)\/\d+/i.test(input.trim());
}

const codecDisplayNames: Record<string, string> = {
  h264: "H.264",
  h265: "H.265",
  vp9: "VP9",
  av1: "AV1",
  aac: "AAC",
  opus: "Opus",
  mp3: "MP3",
};

const qualityGroupOrder = ["video", "combined", "audio"] as const;

function groupQualityOptions(options: Quality[]): Array<[string, Quality[]]> {
  const groups = new Map<string, Quality[]>();
  for (const option of options) {
    const key = option.group ?? "video";
    const bucket = groups.get(key);
    if (bucket) bucket.push(option);
    else groups.set(key, [option]);
  }
  return [...groups.entries()].sort(
    ([a], [b]) => qualityGroupOrder.indexOf(a as never) - qualityGroupOrder.indexOf(b as never),
  );
}

function qualityGroupLabel(group: string, t: any): string {
  switch (group) {
    case "audio":
      return t("add.group_audio", "Аудио");
    case "combined":
      return t("add.group_combined", "Готовые дорожки");
    default:
      return t("add.group_video", "Видео");
  }
}

// Builds "1080p60 · H.264 · mp4 · 1,1 ГБ". The backend deliberately keeps the
// label bare so the container is not printed twice.
function formatQuality(quality: Quality, t: any, codecPolicy: VideoCodecPolicy): string {
  const parts = [quality.label];
  const codec = quality.has_video ? quality.vcodec : quality.acodec;
  if (codec) parts.push(codecDisplayNames[codec] ?? codec);
  if (quality.ext) parts.push(quality.ext);
  if (quality.filesize) parts.push(formatBytes(quality.filesize));
  // Video-only renditions on YouTube get an audio track merged in; everywhere
  // else (Twitch/HLS variants) a missing audio codec really means silence.
  if (quality.has_video && !quality.has_audio && quality.group !== "video") {
    parts.push(t("add.no_audio", "без звука"));
  }
  // Only warn when the compatibility policy is actually going to act on it.
  if (quality.has_video && !quality.compatible && codecPolicy === "compatible") {
    parts.push(t("add.needs_transcode", "перекод"));
  }
  return parts.join(" · ");
}
