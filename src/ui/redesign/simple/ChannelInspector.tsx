import { useMemo } from "react";

import type { LinkInfo } from "@/services/streams/linkKind";
import type { SearchRow } from "@/services/streams/streamSearch";
import type { Quality } from "@/types/job";
import { RemoteImage } from "@/ui/redesign/media/RemoteImage";

import styles from "./DownloadOverlay.module.css";
import { ClipFields, DownloadOptions, QualityPicker, type DownloadDraft } from "./downloadOptions";
import { effectiveDraft, formatClock, type RowOverride } from "./rowOverrides";

export const CHANNEL_DEFAULT_QUALITIES: Quality[] = [
  {
    id: "1440p60",
    label: "1440p60",
    height: 1440,
    fps: 60,
    ext: "mp4",
    has_audio: true,
    has_video: true,
    abr: null,
    vcodec: "h265",
    acodec: "aac",
    filesize: null,
    tbr: null,
    compatible: false,
  },
  {
    id: "1080p60",
    label: "1080p60",
    height: 1080,
    fps: 60,
    ext: "mp4",
    has_audio: true,
    has_video: true,
    abr: null,
    vcodec: "h264",
    acodec: "aac",
    filesize: null,
    tbr: null,
    compatible: true,
  },
  {
    id: "720p60",
    label: "720p60",
    height: 720,
    fps: 60,
    ext: "mp4",
    has_audio: true,
    has_video: true,
    abr: null,
    vcodec: "h264",
    acodec: "aac",
    filesize: null,
    tbr: null,
    compatible: true,
  },
  {
    id: "480p",
    label: "480p",
    height: 480,
    fps: 30,
    ext: "mp4",
    has_audio: true,
    has_video: true,
    abr: null,
    vcodec: "h264",
    acodec: "aac",
    filesize: null,
    tbr: null,
    compatible: true,
  },
  {
    id: "360p",
    label: "360p",
    height: 360,
    fps: 30,
    ext: "mp4",
    has_audio: true,
    has_video: true,
    abr: null,
    vcodec: "h264",
    acodec: "aac",
    filesize: null,
    tbr: null,
    compatible: true,
  },
];

/** Видимые качества: с картинкой, от высокого к низкому, без повторов подписи. */
export function pickQualities(all: Quality[], fallbackToPresets = false): Quality[] {
  const seen = new Set<string>();
  const picked = all
    .filter((item) => item.has_video)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.fps ?? 0) - (a.fps ?? 0))
    .filter((item) => {
      if (seen.has(item.label)) return false;
      seen.add(item.label);
      return true;
    });
  return picked.length > 0 ? picked : fallbackToPresets ? CHANNEL_DEFAULT_QUALITIES : [];
}

export type InspectorTab = "all" | "item";

export function InspectorTabs({ tab, canFocus, onChange }: { tab: InspectorTab; canFocus: boolean; onChange: (tab: InspectorTab) => void }) {
  return (
    <div className={`${styles.segment} ${styles.segmentWide}`} role="tablist" aria-label="Чьи настройки">
      <button type="button" role="tab" className={styles.segmentItem} aria-pressed={tab === "all"} aria-selected={tab === "all"} onClick={() => onChange("all")}>
        Все выбранные
      </button>
      <button
        type="button"
        role="tab"
        className={styles.segmentItem}
        aria-pressed={tab === "item"}
        aria-selected={tab === "item"}
        disabled={!canFocus}
        title={canFocus ? undefined : "Нажми на запись в списке"}
        onClick={() => onChange("item")}
      >
        Эта запись
      </button>
    </div>
  );
}

interface ItemInspectorProps {
  link: LinkInfo;
  row: SearchRow;
  common: DownloadDraft;
  own: RowOverride | undefined;
  onPatch: (patch: RowOverride) => void;
  onReset: () => void;
}

/** Свои настройки одной записи канала: фрагмент, качество, переключатели, имя. */
export function ItemInspector({ link, row, common, own, onPatch, onReset }: ItemInspectorProps) {
  const draft = effectiveDraft(common, row, own);
  const recovered = row.kind === "recovered";
  const live = row.kind === "live";
  const qualities = useMemo(() => pickQualities(row.qualities, !live), [row.qualities, live]);

  return (
    <>
      <div className={styles.focusHead} key={row.id}>
        <span className={styles.focusThumb}>
          <RemoteImage className={styles.thumb} src={row.thumbnailUrl} alt="" platform={row.platform} fallbackLabel={null} />
        </span>
        <div className={styles.focusText}>
          <b>{row.title}</b>
          <span className={styles.itemMeta}>
            {row.durationSeconds ? `${recovered ? "≈ " : ""}${formatClock(row.durationSeconds)}` : row.duration}
          </span>
        </div>
      </div>

      <ClipFields
        draft={draft}
        patch={onPatch}
        live={live}
        length={row.durationSeconds}
        approximate={recovered}
        liveArchive={row.liveArchive}
      />
      {recovered && <p className={styles.warning}>Длина примерная: точную узнаю после восстановления ссылки.</p>}

      <QualityPicker draft={draft} patch={onPatch} qualities={qualities} audio={link.supportsAudioOnly && !live} />

      <DownloadOptions
        link={link}
        draft={draft}
        patch={onPatch}
        chooseFolder={() => undefined}
        chatPossible={link.supportsChat && row.chatAvailable}
        live={live}
        hideFolder
      />

      {own ? (
        <button type="button" className={`${styles.ghost} ${styles.ghostDanger}`} onClick={onReset}>
          Сбросить к общим
        </button>
      ) : (
        <p className={styles.note}>Пока как у всех. Любое изменение сделает настройки своими.</p>
      )}
    </>
  );
}
