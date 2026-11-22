import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { formatBytes } from "@/lib/format";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { LinkInfo } from "@/services/streams/linkKind";
import { activeBlurZones, type LiveCapture, type QueueOptions } from "@/services/streams/streamDownload";
import type { LiveArchive } from "@/services/streams/streamSearch";
import { useSettings } from "@/stores/settings";
import { useUI } from "@/stores/ui";
import { useWorkflowPresets } from "@/stores/workflowPresets";
import type { Quality } from "@/types/job";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";

import styles from "./DownloadOverlay.module.css";
import { RangePicker, type ExtraRangeItem } from "./RangePicker";

/** Всё, что можно настроить перед скачиванием. Остальное подбирается само. */
export interface DownloadDraft {
  quality: Quality | null;
  audioOnly: boolean;
  withChat: boolean;
  unmute: boolean;
  muteProfanity: boolean;
  blurSponsors: boolean;
  name: string;
  directory: string;
  start: string;
  end: string;
  extraRanges: ExtraRangeItem[];
  /** Эфир: писать с текущего момента или скачать прошедший отрезок. */
  liveCapture: LiveCapture;
  /** Пресет рендера чата; пусто — общие настройки чата. */
  chatPresetId: string | null;
  /** Пресет блюра спонсоров; пусто — активный. */
  sponsorPresetId: string | null;
}

function blankDraft(name: string, directory: string, initialStart = ""): DownloadDraft {
  return {
    quality: null,
    audioOnly: false,
    withChat: false,
    unmute: false,
    muteProfanity: false,
    blurSponsors: false,
    name,
    directory,
    start: initialStart,
    end: "",
    extraRanges: [],
    liveCapture: "record",
    chatPresetId: useWorkflowPresets.getState().activeChatPresetId || null,
    sponsorPresetId: useWorkflowPresets.getState().activeSponsorPresetId || null,
  };
}

export function useDownloadDraft(defaultName: string, defaultDirectory: string, initialStart = "") {
  const dirTouched = useRef(false);
  const [draft, setDraft] = useState<DownloadDraft>(() => blankDraft(defaultName, defaultDirectory, initialStart));
  const draftRef = useRef<DownloadDraft>(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (!dirTouched.current && defaultDirectory) {
      setDraft((current) => {
        if (current.directory === defaultDirectory) return current;
        const next = { ...current, directory: defaultDirectory };
        draftRef.current = next;
        return next;
      });
    }
  }, [defaultDirectory]);

  const patch = (next: Partial<DownloadDraft>) => {
    if (next.directory !== undefined) dirTouched.current = true;
    const updated = { ...draftRef.current, ...next };
    draftRef.current = updated;
    setDraft(updated);
  };

  const chooseFolder = async () => {
    const picked = await ipc.chooseDirectory().catch(() => null);
    if (picked) {
      dirTouched.current = true;
      patch({ directory: picked });
      useSettings.getState().setDirectory(picked);
    }
  };

  const toQueueOptions = (extra: { chatPossible: boolean; single: boolean }): QueueOptions => {
    const current = draftRef.current;
    return {
      withChat: current.withChat && extra.chatPossible,
      quality: current.quality,
      audioOnly: current.audioOnly,
      name: extra.single ? current.name : undefined,
      directory: current.directory,
      start: extra.single ? current.start : undefined,
      end: extra.single ? current.end : undefined,
      extraRanges: extra.single ? current.extraRanges : undefined,
      liveCapture: current.liveCapture,
      unmute: current.unmute,
      muteProfanity: current.muteProfanity,
      blurSponsors: current.blurSponsors,
      chatPresetId: current.chatPresetId,
      sponsorPresetId: current.sponsorPresetId,
    };
  };

  return { draft, patch, chooseFolder, toQueueOptions };
}

type DraftPatch = (next: Partial<DownloadDraft>) => void;

interface QualityProps {
  draft: DownloadDraft;
  patch: DraftPatch;
  qualities: Quality[];
  audio: boolean;
}

const CODEC_NAME: Record<string, string> = {
  h264: "H.264",
  h265: "H.265",
  vp9: "VP9",
  av1: "AV1",
  aac: "AAC",
  opus: "Opus",
  mp3: "MP3",
};

function qualityTooltip(item: Quality): string | undefined {
  const parts: string[] = [];
  const codec = item.vcodec ?? item.acodec;
  if (codec) parts.push(CODEC_NAME[codec] ?? codec);
  if (item.fps) parts.push(`${Math.round(item.fps)} fps`);
  if (item.filesize) parts.push(`≈ ${formatBytes(item.filesize)}`);
  else if (item.tbr) parts.push(`≈ ${Math.round(item.tbr)} кбит/с`);
  return parts.length > 0 ? `${item.label} · ${parts.join(" · ")}` : undefined;
}

/** Сегменты качества: «Лучшее», доступные качества и «Аудио», если ссылка его умеет. */
export function QualityPicker({ draft, patch, qualities, audio }: QualityProps) {
  const [expanded, setExpanded] = useState(false);
  const canCollapse = qualities.length > 5;
  const selectedInTail = canCollapse && qualities.slice(4).some((item) => item.id === draft.quality?.id);
  const visibleQualities = !canCollapse || expanded || selectedInTail ? qualities : qualities.slice(0, 4);
  const hiddenCount = qualities.length - visibleQualities.length;

  return (
    <div className={styles.section}>
      <span className={styles.sectionLabel}>Качество</span>
      <div className={styles.segment} role="radiogroup" aria-label="Качество">
        <Segment on={!draft.audioOnly && draft.quality === null} onClick={() => patch({ quality: null, audioOnly: false })}>
          Лучшее
        </Segment>
        {visibleQualities.map((item) => (
          <Segment
            key={item.id}
            on={!draft.audioOnly && draft.quality?.id === item.id}
            title={qualityTooltip(item)}
            onClick={() => patch({ quality: item, audioOnly: false })}
          >
            {item.label}
          </Segment>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            className={styles.segmentItem}
            title="Показать остальные разрешения"
            onClick={() => setExpanded(true)}
          >
            +{hiddenCount}
          </button>
        )}
        {expanded && canCollapse && !selectedInTail && (
          <button
            type="button"
            className={styles.segmentItem}
            title="Свернуть список разрешений"
            onClick={() => setExpanded(false)}
          >
            Свернуть
          </button>
        )}
        {audio && (
          <Segment on={draft.audioOnly} onClick={() => patch({ audioOnly: true, quality: null })}>
            Аудио
          </Segment>
        )}
      </div>
    </div>
  );
}

function Segment({ on, title, onClick, children }: { on: boolean; title?: string; onClick: () => void; children: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} title={title} className={styles.segmentItem} onClick={onClick}>
      {children}
    </button>
  );
}

interface OptionsProps {
  link: LinkInfo;
  draft: DownloadDraft;
  patch: DraftPatch;
  chooseFolder: () => void;
  chatPossible: boolean;
  live: boolean;
  /** Папка общая для всех записей: в своих настройках записи её нет. */
  hideFolder?: boolean;
}

/** Сгруппированный список, как в настройках: переключатели и папка. Только то, что применимо к ссылке. */
export function DownloadOptions({ link, draft, patch, chooseFolder, chatPossible, live, hideFolder }: OptionsProps) {
  const navigate = useNavigate();
  const chatPresets = useWorkflowPresets((state) => state.chatPresets);
  const sponsorPresets = useWorkflowPresets((state) => state.sponsorPresets);
  const blurZones = activeBlurZones(draft.sponsorPresetId).length;
  const isTwitchVod = link.platform === "twitch" && (link.type === "vod" || link.type === "channel");
  const video = !live && !draft.audioOnly;

  const openSponsorBlurEditor = () => {
    useUI.getState().closeDownload();
    void navigate({ to: "/sponsor-blur" });
  };

  return (
    <div className={styles.groupList}>
      {link.supportsChat && video && (
        <SwitchRow
          icon="chat"
          tone="purple"
          label="Чат"
          hint={chatPossible ? "Вместе с записью" : "Чата нет"}
          title={
            chatPossible
              ? "Скачать чат и наложить его на видео по пресету"
              : "У этой записи нет сохранённого чата (эфир, клип или платформа не отдаёт чат)"
          }
          checked={draft.withChat && chatPossible}
          disabled={!chatPossible}
          onChange={(value) => patch({ withChat: value })}
        />
      )}
      {link.supportsChat && video && draft.withChat && chatPossible && chatPresets.length > 0 && (
        <PresetRow
          label="Пресет чата"
          title="Вид чата на видео: размер, позиция, шрифт. Пресеты настраиваются на странице чата"
          value={draft.chatPresetId}
          options={chatPresets}
          onChange={(id) => patch({ chatPresetId: id })}
        />
      )}
      {isTwitchVod && !live && (
        <SwitchRow
          icon="audio"
          tone="blue"
          label="Вернуть звук"
          hint="Заглушённые места VOD"
          title="Twitch заглушает куски VOD из-за музыки; Fetchr попробует вернуть звук в этих местах"
          checked={draft.unmute}
          onChange={(value) => patch({ unmute: value })}
        />
      )}
      {video && (
        <SwitchRow
          icon="mute"
          tone="teal"
          label="Убрать маты"
          hint="После скачивания"
          title="После скачивания найдёт нецензурную речь и заменит её локально, без интернета. Способ замены — на странице «Удалить маты»"
          checked={draft.muteProfanity}
          onChange={(value) => patch({ muteProfanity: value })}
        />
      )}
      {video && blurZones > 0 && (
        <SwitchRow
          icon="blur"
          tone="orange"
          label="Блюр спонсоров"
          hint={`Зон: ${blurZones}`}
          title={`Размоет рекламные плашки спонсоров в отмеченных зонах кадра. Активных зон в пресете: ${blurZones}`}
          checked={draft.blurSponsors}
          onChange={(value) => patch({ blurSponsors: value })}
          action={{ label: "Настроить зоны", onClick: openSponsorBlurEditor }}
        />
      )}
      {video && blurZones === 0 && (
        <button
        type="button"
        className={styles.groupRow}
        onClick={openSponsorBlurEditor}
        title="Размытие рекламы спонсоров: сначала отметь зоны в редакторе блюра"
      >
          <span className={cn(styles.rowIcon, styles.tone_orange)} aria-hidden>
            <RedesignIcon name="blur" className="size-3.5" />
          </span>
          <span className={styles.rowText}>
            <span>Блюр спонсоров</span>
            <small>Нет зон — открыть редактор блюра</small>
          </span>
          <RedesignIcon name="chevronDown" className={styles.chevron} />
        </button>
      )}
      {video && draft.blurSponsors && blurZones > 0 && sponsorPresets.length > 1 && (
        <PresetRow
          label="Пресет блюра"
          title="Набор зон блюра; число после названия — сколько зон включено"
          value={draft.sponsorPresetId}
          options={sponsorPresets.map((item) => ({ id: item.id, name: `${item.name} · ${item.zones.filter((zone) => zone.enabled).length}` }))}
          onChange={(id) => patch({ sponsorPresetId: id })}
        />
      )}
      {!hideFolder && (
      <button type="button" className={styles.groupRow} onClick={chooseFolder} title={draft.directory}>
        <span className={cn(styles.rowIcon, styles.tone_gray)} aria-hidden>
          <RedesignIcon name="folder" className="size-3.5" />
        </span>
        <span className={styles.rowText}>
          <span>Папка</span>
          <small>{draft.directory || "Не выбрана"}</small>
        </span>
        <RedesignIcon name="folder" className={styles.trailIcon} />
      </button>
      )}
    </div>
  );
}

interface PresetRowProps {
  label: string;
  title?: string;
  value: string | null;
  options: Array<{ id: string; name: string }>;
  onChange: (id: string) => void;
}

/** Выбор пресета под своим переключателем; без иконки, чтобы читался как его продолжение. */
function PresetRow({ label, title, value, options, onChange }: PresetRowProps) {
  return (
    <label className={cn(styles.groupRow, styles.presetRow)} title={title}>
      <span className={styles.rowText}>
        <small>{label}</small>
      </span>
      <select className={styles.presetSelect} value={value ?? options[0]?.id ?? ""} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}

interface SwitchRowProps {
  icon: RedesignIconName;
  tone: "purple" | "blue" | "teal" | "orange";
  label: string;
  hint: string;
  title?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  action?: { label: string; onClick: () => void };
}

function SwitchRow({ icon, tone, label, hint, title, checked, disabled, onChange, action }: SwitchRowProps) {
  if (action) {
    return (
      <div
        role="switch"
        tabIndex={disabled ? -1 : 0}
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        className={styles.groupRow}
        title={title}
        onClick={() => !disabled && onChange(!checked)}
        onKeyDown={(event) => {
          if (!disabled && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onChange(!checked);
          }
        }}
      >
        <span className={cn(styles.rowIcon, styles[`tone_${tone}`])} aria-hidden>
          <RedesignIcon name={icon} className="size-3.5" />
        </span>
        <span className={styles.rowText}>
          <span>{label}</span>
          <small>{hint}</small>
        </span>
        <button
          type="button"
          className={styles.rowActionBtn}
          onClick={(event) => {
            event.stopPropagation();
            action.onClick();
          }}
        >
          {action.label}
        </button>
        <span className={styles.switch} aria-hidden />
      </div>
    );
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={styles.groupRow}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span className={cn(styles.rowIcon, styles[`tone_${tone}`])} aria-hidden>
        <RedesignIcon name={icon} className="size-3.5" />
      </span>
      <span className={styles.rowText}>
        <span>{label}</span>
        <small>{hint}</small>
      </span>
      <span className={styles.switch} aria-hidden />
    </button>
  );
}

/** Фрагмент и имя файла: для одной записи и для своих настроек записи канала. */
export function ClipFields({
  draft,
  patch,
  live,
  length,
  initialStart,
  approximate,
  liveArchive,
}: {
  draft: DownloadDraft;
  patch: DraftPatch;
  live: boolean;
  length: number | null;
  initialStart?: string;
  approximate?: boolean;
  liveArchive?: LiveArchive | null;
}) {
  const range = live && liveArchive && draft.liveCapture === "range";
  return (
    <div className={styles.clipFields}>
      {live && liveArchive && (
        <div className={styles.section}>
          <div className={`${styles.segment} ${styles.segmentWide}`} role="radiogroup" aria-label="Что сделать с эфиром">
            <button
              type="button"
              role="radio"
              className={styles.segmentItem}
              aria-pressed={draft.liveCapture === "record"}
              aria-checked={draft.liveCapture === "record"}
              onClick={() => patch({ liveCapture: "record", start: "", end: "" })}
            >
              Записывать эфир
            </button>
            <button
              type="button"
              role="radio"
              className={styles.segmentItem}
              aria-pressed={draft.liveCapture === "range"}
              aria-checked={draft.liveCapture === "range"}
              onClick={() => patch({ liveCapture: "range" })}
            >
              Скачать отрезок
            </button>
          </div>
          <p className={styles.note}>
            {range
              ? "Отрезок из уже прошедшей части эфира — качается из записи, которую Twitch пишет по ходу эфира."
              : "Запись идёт с текущего момента до конца эфира или до остановки."}
          </p>
        </div>
      )}
      {range && (
        <RangePicker
          length={liveArchive.elapsedSeconds}
          start={draft.start}
          end={draft.end}
          approximate
          onChange={(next) => patch(next)}
        />
      )}
      {!live && (
        <RangePicker
          length={length}
          start={draft.start}
          end={draft.end}
          initialStart={initialStart}
          approximate={approximate}
          onChange={(next) => patch(next)}
          extraRanges={draft.extraRanges}
          onExtraRangesChange={(extraRanges) => patch({ extraRanges })}
        />
      )}
      <label className={styles.section}>
        <span className={styles.sectionLabel}>Имя файла</span>
        <input
          className={styles.textInput}
          value={draft.name}
          onChange={(event) => patch({ name: event.target.value })}
          spellCheck={false}
        />
      </label>
    </div>
  );
}
