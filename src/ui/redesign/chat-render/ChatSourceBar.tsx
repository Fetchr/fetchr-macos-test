import { cn } from "@/lib/utils";
import { RedesignIcon, PlatformIcon } from "@/ui/redesign/icons/iconMap";

import type { ExportStatus } from "./ChatOnlyExportPanel";
import { CHAT_PLATFORMS, type ChatPlatform } from "./ChatPlatformSelector";
import studio from "./ChatStudio.module.css";

interface SourceBarProps {
  platform: ChatPlatform;
  sourceUrl: string;
  messageCount: number | null;
  frameLoading: boolean;
  status: ExportStatus | null;
  frameError: string | null;
  onSourceUrlChange: (value: string) => void;
  onPlatformChange: (value: ChatPlatform) => void;
  onChooseJsonFile: () => void;
  onUpdatePreview: () => void;
  onChooseBgImage: () => void;
}

/** Откуда чат: ссылка или JSON, платформа, статус и кадр для превью. */
export function ChatSourceBar({
  platform,
  sourceUrl,
  messageCount,
  frameLoading,
  status,
  frameError,
  onSourceUrlChange,
  onPlatformChange,
  onChooseJsonFile,
  onUpdatePreview,
  onChooseBgImage,
}: SourceBarProps) {
  const localJson = sourceUrl.toLowerCase().endsWith(".json");
  return (
    <div className={studio.source}>
      <div className={studio.sourceRow}>
        <div className={studio.field}>
          <RedesignIcon name="link" className={studio.fieldIcon} />
          <input
            className={studio.fieldInput}
            value={sourceUrl}
            placeholder="Ссылка на запись Twitch или Kick, или JSON чата (Twitch / Kick / W.TV)"
            onChange={(event) => onSourceUrlChange(event.target.value)}
            spellCheck={false}
            aria-label="Ссылка на запись или JSON чата"
          />
          {messageCount != null && messageCount > 0 ? (
            <span className={cn(studio.chip, studio.chipOk)}>Сообщений: {messageCount.toLocaleString("ru-RU")}</span>
          ) : frameLoading ? (
            <span className={studio.chip}>Кадр…</span>
          ) : null}
        </div>
        <div className={studio.segment} role="radiogroup" aria-label="Платформа чата">
          {CHAT_PLATFORMS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={platform === id}
              className={studio.segmentItem}
              onClick={() => onPlatformChange(id)}
            >
              <PlatformIcon platform={id} className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
        <button type="button" className={studio.iconButton} onClick={onChooseJsonFile} title="Выбрать локальный JSON чата">
          <RedesignIcon name="exportJson" />
        </button>
        <button
          type="button"
          className={studio.iconButton}
          onClick={onUpdatePreview}
          disabled={frameLoading || !sourceUrl.trim() || localJson}
          title={localJson ? "Кадр из видео недоступен для локального JSON" : "Обновить кадр из VOD"}
        >
          <RedesignIcon name={frameLoading ? "loading" : "preview"} className={frameLoading ? "animate-spin" : undefined} />
        </button>
        <button type="button" className={studio.iconButton} onClick={onChooseBgImage} title="Своя картинка фоном превью">
          <RedesignIcon name="image" />
        </button>
      </div>
      {(status || frameError) && (
        <p
          className={cn(
            studio.notice,
            (status?.kind === "error" || (!status && frameError)) && studio.noticeError,
            status?.kind === "success" && studio.noticeOk,
          )}
          role={status?.kind === "error" ? "alert" : "status"}
        >
          {status?.text ?? frameError}
        </p>
      )}
    </div>
  );
}

interface RangeBarProps {
  start: string;
  end: string;
  startError: string | null;
  endError: string | null;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
}

/** Отрезок записи: начало и конец. Пустые поля значат «весь VOD». */
export function ChatRangeBar({ start, end, startError, endError, onStartChange, onEndChange }: RangeBarProps) {
  const whole = !start.trim() && !end.trim();
  return (
    <div className={studio.range}>
      <span className={studio.label}>Отрезок</span>
      <input
        className={cn(studio.timeInput, startError && studio.timeInvalid)}
        value={start}
        placeholder="с начала"
        onChange={(event) => onStartChange(event.target.value)}
        aria-label="Начало"
        title={startError ?? "ЧЧ:ММ:СС"}
      />
      <span className={studio.rangeDash}>–</span>
      <input
        className={cn(studio.timeInput, endError && studio.timeInvalid)}
        value={end}
        placeholder="до конца"
        onChange={(event) => onEndChange(event.target.value)}
        aria-label="Конец"
        title={endError ?? "ЧЧ:ММ:СС"}
      />
      <button
        type="button"
        className={studio.ghost}
        disabled={whole}
        onClick={() => {
          onStartChange("");
          onEndChange("");
        }}
      >
        Весь VOD
      </button>
      {(startError || endError) && <span className={studio.rangeError}>{startError ?? endError}</span>}
    </div>
  );
}
