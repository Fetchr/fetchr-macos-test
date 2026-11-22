import type { TFunction } from "i18next";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { LinkInfo } from "@/services/streams/linkKind";
import type { QueueOptions } from "@/services/streams/streamDownload";
import type { SearchRow, SearchRowKind } from "@/services/streams/streamSearch";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { MediaPreviewOverlay, type MediaPreviewTarget } from "@/ui/redesign/media/MediaPreviewOverlay";
import { RemoteImage } from "@/ui/redesign/media/RemoteImage";

import styles from "./DownloadOverlay.module.css";
import { InspectorTabs, ItemInspector, pickQualities, type InspectorTab } from "./ChannelInspector";
import { ClipFields, DownloadOptions, QualityPicker, useDownloadDraft, type DownloadDraft } from "./downloadOptions";
import {
  clipSeconds,
  clipWindow,
  formatClock,
  formatTotal,
  overrideSummary,
  parseClock,
  toPerRow,
  type RowOverride,
  type RowOverrides,
} from "./rowOverrides";

function markStartPatch(sec: number, currentEnd: string | undefined): { start: string; end?: string } {
  const start = sec > 0 ? formatClock(sec) : "";
  const endSec = parseClock(currentEnd);
  if (endSec !== null && sec >= endSec) return { start, end: "" };
  return { start };
}

function markEndPatch(sec: number, currentStart: string | undefined): { start?: string; end: string } {
  const safeSec = Math.max(1, sec);
  const end = formatClock(safeSec);
  const startSec = parseClock(currentStart);
  if (startSec !== null && safeSec <= startSec) return { start: "", end };
  return { end };
}

type Filter = "all" | SearchRowKind;

interface ResultsProps {
  link: LinkInfo;
  rows: SearchRow[];
  warnings: string[];
  submitting: boolean;
  directory: string;
  /** Окно открыто и результаты на экране: только тогда работает Ctrl+Enter. */
  active: boolean;
  /** Возвращает id строк, которые встали в очередь. */
  onQueue: (rows: SearchRow[], options: QueueOptions) => Promise<string[]>;
}

/** Канал: список слева с мультивыбором, справа инспектор общих или своих настроек записи. */
export function ChannelResults({ link, rows, warnings, submitting, directory, active, onQueue }: ResultsProps) {
  const { t, i18n } = useTranslation();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<InspectorTab>("all");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<RowOverrides>({});
  const [autoSelectedId, setAutoSelectedId] = useState<string | null>(null);
  const overridesRef = useRef<RowOverrides>(overrides);
  overridesRef.current = overrides;
  const anchorRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const { draft, patch, chooseFolder, toQueueOptions } = useDownloadDraft("", directory);

  const counts = useMemo(() => {
    const base: Record<Filter, number> = { all: rows.length, live: 0, vod: 0, clip: 0, recovered: 0 };
    for (const row of rows) base[row.kind] += 1;
    return base;
  }, [rows]);
  const commonQualities = useMemo(() => pickQualities(rows.flatMap((row) => row.qualities), true), [rows]);
  const filters = FILTERS.filter((id) => id === "all" || counts[id] > 0);
  const byKind = filter === "all" ? rows : rows.filter((row) => row.kind === filter);
  const needle = search.trim().toLowerCase();
  const visible = needle ? byKind.filter((row) => row.title.toLowerCase().includes(needle)) : byKind;
  const chosen = rows.filter((row) => selected.has(row.id));
  const focused = rows.find((row) => row.id === focusId) ?? null;
  const effectiveChosen = chosen.length > 0 ? chosen : focused ? [focused] : [];
  const chosenSeconds = effectiveChosen.reduce((sum, row) => sum + clipSeconds(row, overrides[row.id]), 0);
  const chosenOwn = effectiveChosen.filter((row) => overrides[row.id]).length;
  const chosenRecovered = effectiveChosen.filter((row) => row.kind === "recovered").length;
  const chatPossible = link.supportsChat && effectiveChosen.some((row) => row.chatAvailable);
  const allSelected = visible.length > 0 && visible.every((row) => selected.has(row.id));
  const showItem = tab === "item" && focused !== null;
  const approx = chosenRecovered > 0 ? "≈ " : "";
  // Roving tabindex: в список заходит одна строка — последняя активная или первая.
  const rovingId = visible.some((row) => row.id === activeId) ? activeId : (visible[0]?.id ?? null);
  const nothingChosen = t("simple.nothing_chosen", "Ничего не выбрано: кликни по записи в списке, чтобы отметить её.");
  const describeRow = (row: SearchRow) => describe(row, t, i18n.language);

  const toggle = (id: string) => {
    if (id === autoSelectedId) setAutoSelectedId(null);
    anchorRef.current = id;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Shift: отмечает всё от предыдущей отмеченной строки до этой включительно.
  const selectRange = (id: string) => {
    const from = visible.findIndex((row) => row.id === anchorRef.current);
    const to = visible.findIndex((row) => row.id === id);
    if (from === -1 || to === -1) {
      toggle(id);
      return;
    }
    const [lo, hi] = from < to ? [from, to] : [to, from];
    const ids = visible.slice(lo, hi + 1).map((row) => row.id);
    anchorRef.current = id;
    setSelected((current) => new Set([...current, ...ids]));
  };

  const toggleAll = () =>
    setSelected((current) => {
      const next = new Set(current);
      if (allSelected) visible.forEach((row) => next.delete(row.id));
      else visible.forEach((row) => next.add(row.id));
      return next;
    });

  const focus = (id: string) => {
    setFocusId(id);
    setTab("item");
  };

  // Свои настройки имеют смысл только у выбранной записи, поэтому правка её и выбирает;
  // об этом сообщает подсказка под инспектором.
  const patchOwn = (id: string, next: RowOverride) => {
    const updated = { ...overridesRef.current, [id]: { ...overridesRef.current[id], ...next } };
    overridesRef.current = updated;
    setOverrides(updated);
    if (!selected.has(id)) {
      setAutoSelectedId(id);
      setSelected((current) => new Set(current).add(id));
    }
  };

  const resetOwn = (id: string) => {
    const updated = Object.fromEntries(Object.entries(overridesRef.current).filter(([key]) => key !== id));
    overridesRef.current = updated;
    setOverrides(updated);
  };

  const [preview, openPreview] = useMediaPreview(describeRow, {
    onMarkStart: (row, sec) => {
      focus(row.id);
      const cur = overridesRef.current[row.id];
      patchOwn(row.id, markStartPatch(sec, cur?.end));
    },
    onMarkEnd: (row, sec) => {
      focus(row.id);
      const cur = overridesRef.current[row.id];
      patchOwn(row.id, markEndPatch(sec, cur?.start));
    },
    getRangeInfo: (row) => {
      const cur = overrides[row.id];
      return {
        start: cur?.start,
        end: cur?.end,
        extraCount: cur?.extraRanges?.filter((r) => r.start.trim() || r.end.trim()).length ?? 0,
      };
    },
    onAddExtraRange: (row) => {
      focus(row.id);
      const cur = overridesRef.current[row.id];
      if (!cur?.start && !cur?.end) return;
      patchOwn(row.id, {
        extraRanges: [...(cur.extraRanges ?? []), { id: crypto.randomUUID(), start: cur.start ?? "", end: cur.end ?? "" }],
        start: "",
        end: "",
      });
    },
  });

  const queueRows = (target: SearchRow[]) => {
    if (target.length === 0 || submitting) return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    const targetChat = link.supportsChat && target.some((row) => row.chatAvailable);
    // Вставшие строки снимаются с выбора: повторное «Скачать» после частичного
    // сбоя должно брать только оставшиеся, а не ставить удачные второй раз.
    void onQueue(target, {
      ...toQueueOptions({ chatPossible: targetChat, single: target.length === 1 }),
      perRow: toPerRow(target, overridesRef.current),
    }).then((queuedIds) => {
      if (queuedIds.length === 0) return;
      const queued = new Set(queuedIds);
      setSelected((current) => new Set([...current].filter((id) => !queued.has(id))));
      setFocusId((current) => (current && queued.has(current) ? null : current));
    });
  };

  const submit = () => queueRows(effectiveChosen);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (otherModalOpen()) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && effectiveChosen.length > 0 && !submitting) {
        event.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const focusRowAt = (index: number) => {
    const row = visible[index];
    if (!row) return;
    setActiveId(row.id);
    listRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(row.id)}"]`)?.focus();
  };

  const handleRowKey = (event: ReactKeyboardEvent, row: SearchRow, index: number, element: HTMLElement): boolean => {
    switch (event.key) {
      case "ArrowDown":
        focusRowAt(Math.min(index + 1, visible.length - 1));
        return true;
      case "ArrowUp":
        focusRowAt(Math.max(index - 1, 0));
        return true;
      case "Home":
        focusRowAt(0);
        return true;
      case "End":
        focusRowAt(visible.length - 1);
        return true;
      case " ":
        if (event.shiftKey) selectRange(row.id);
        else toggle(row.id);
        return true;
      case "Enter":
        queueRows(chosen.length > 0 ? chosen : [row]);
        return true;
    }
    // По коду клавиши: в русской раскладке A/P/S дают другие буквы.
    switch (event.code) {
      case "KeyA":
        toggleAll();
        return true;
      case "KeyP": {
        const box = element.querySelector<HTMLElement>("[data-thumb]");
        if (row.url && box) openPreview(row, box);
        return true;
      }
      case "KeyS":
        focus(row.id);
        return true;
    }
    return false;
  };

  // Клавиши работают только на строке списка: в полях ввода буквы остаются буквами.
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const rowId = target.getAttribute("role") === "option" ? target.dataset.rowId : undefined;
    if (!rowId || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = visible.findIndex((row) => row.id === rowId);
    const row = visible[index];
    if (!row) return;
    if (handleRowKey(event, row, index, target)) event.preventDefault();
  };

  return (
    <div className={styles.split}>
      {preview}
      <section className={styles.listPane}>
        <div className={styles.listHead}>
          <div className={styles.segment} role="group" aria-label={t("simple.filter_group", "Тип записи")}>
            {filters.map((id) => (
              <button
                key={id}
                type="button"
                className={styles.segmentItem}
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {filterLabel(id, t)}
                <b>{counts[id]}</b>
              </button>
            ))}
          </div>
          <input
            type="search"
            className={styles.listSearch}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("simple.list_search", "Поиск по названию…")}
            aria-label={t("simple.list_search_label", "Поиск по названию")}
          />
          <button type="button" className={styles.ghost} onClick={toggleAll} disabled={visible.length === 0}>
            {allSelected ? t("simple.deselect_all", "Снять всё") : t("simple.select_all", "Выбрать всё")}
          </button>
        </div>

        <div
          ref={listRef}
          className={styles.list}
          role="listbox"
          aria-multiselectable="true"
          aria-label={t("simple.found_list", "Найденные записи")}
          aria-describedby={LEGEND_ID}
          onKeyDown={onListKeyDown}
        >
          {visible.length === 0 && (
            <p className={styles.empty} role="presentation">
              {rows.length === 0
                ? t("simple.list_empty_none", "Ничего не нашлось. Проверь ссылку или ник.")
                : t("simple.list_empty_tab", "В этой вкладке пусто.")}
            </p>
          )}
          {visible.map((row, index) => (
            <ChannelRow
              key={row.id}
              row={row}
              index={index}
              common={draft}
              own={overrides[row.id]}
              selected={selected.has(row.id)}
              focused={showItem && focusId === row.id}
              tabbable={row.id === rovingId}
              meta={describeRow(row)}
              onToggle={(range) => (range ? selectRange(row.id) : toggle(row.id))}
              onActivate={() => setActiveId(row.id)}
              onConfigure={() => focus(row.id)}
              onPreview={(origin) => openPreview(row, origin)}
            />
          ))}
        </div>
        <KeyLegend />
      </section>

      <aside className={styles.inspector}>
        <InspectorTabs tab={showItem ? "item" : "all"} canFocus={focused !== null} onChange={setTab} />

        {showItem && focused ? (
          <>
            <ItemInspector
              link={link}
              row={focused}
              common={draft}
              own={overrides[focused.id]}
              onPatch={(next) => patchOwn(focused.id, next)}
              onReset={() => resetOwn(focused.id)}
            />
            {autoSelectedId === focused.id && selected.has(focused.id) && (
              <p className={styles.note} role="status">
                {t(
                  "simple.auto_selected_note",
                  "Запись добавлена в выбор: свои настройки применяются только к выбранным записям.",
                )}
              </p>
            )}
          </>
        ) : (
          <>
            <div className={styles.total}>
              <span className={styles.sectionLabel}>{t("simple.selected", "Выбрано")}</span>
              <b>
                {effectiveChosen.length}
                {chosenSeconds > 0 && <small> · {approx + formatTotal(chosenSeconds)}</small>}
              </b>
            </div>

            <QualityPicker draft={draft} patch={patch} qualities={commonQualities} audio={link.supportsAudioOnly} />

            <DownloadOptions
              link={link}
              draft={draft}
              patch={patch}
              chooseFolder={() => void chooseFolder()}
              chatPossible={chatPossible}
              live={false}
            />

            {chosenOwn > 0 && (
              <p className={styles.note}>{t("simple.own_note", "У записей со своими настройками они важнее общих.")}</p>
            )}
            {chosenRecovered > 0 && (
              <p className={styles.note}>
                {chosenRecovered === 1
                  ? t("simple.recovered_one", "Одна запись удалена. Найду живую ссылку сам, до минуты на запись.")
                  : t("simple.recovered_many", "Удалено записей: {{count}}. Найду живую ссылку сам, до минуты на запись.", {
                      count: chosenRecovered,
                    })}
              </p>
            )}
            {warnings.map((warning) => (
              <p key={warning} className={styles.warning}>
                {warning}
              </p>
            ))}
          </>
        )}

        <div className={styles.footer}>
          {effectiveChosen.length > 0 ? (
            <span className={styles.footerSum}>
              {t("simple.records_count", "{{count}} записей", { count: effectiveChosen.length })}
              {chosenOwn > 0 ? ` · ${t("simple.own_count", "{{count}} со своими", { count: chosenOwn })}` : ""}
              {chosenSeconds > 0 ? ` · ${approx}${formatTotal(chosenSeconds)}` : ""}
            </span>
          ) : (
            <span className={styles.footerSum}>{nothingChosen}</span>
          )}
          <button
            type="button"
            className={styles.primary}
            disabled={effectiveChosen.length === 0 || submitting}
            title={effectiveChosen.length === 0 ? nothingChosen : undefined}
            onClick={submit}
          >
            <RedesignIcon name="download" className="size-4" />
            {submitting
              ? t("simple.queueing", "Ставлю в очередь…")
              : chosen.length > 0
                ? t("simple.download_n", "Скачать {{count}}", { count: chosen.length })
                : focused
                  ? focused.kind === "live"
                    ? t("simple.record_live", "Записать эфир")
                    : t("simple.download_this", "Скачать эту запись")
                  : t("simple.pick_records", "Выбери записи")}
          </button>
        </div>
      </aside>
    </div>
  );
}

const LEGEND_ID = "download-results-keys";

/** Компактная подсказка по клавишам списка. */
function KeyLegend() {
  const { t } = useTranslation();
  const items: Array<[string, string]> = [
    ["↑ ↓", t("simple.keys_nav", "навигация")],
    [t("simple.key_space", "Пробел"), t("simple.keys_toggle", "выбрать")],
    [t("simple.key_shift_click", "Shift+клик"), t("simple.keys_range", "диапазон")],
    ["A", t("simple.keys_all", "все")],
    ["P", t("simple.keys_watch", "смотреть")],
    ["S", t("simple.keys_configure", "настроить")],
    ["Enter", t("simple.keys_download", "скачать")],
  ];
  return (
    <p id={LEGEND_ID} className={styles.keyLegend}>
      {items.map(([key, label]) => (
        <span key={key}>
          <kbd>{key}</kbd>
          {label}
        </span>
      ))}
    </p>
  );
}

interface ChannelRowProps {
  row: SearchRow;
  index: number;
  common: DownloadDraft;
  own: RowOverride | undefined;
  selected: boolean;
  focused: boolean;
  /** Строка получает tabIndex=0 (roving tabindex), остальные -1. */
  tabbable: boolean;
  meta: string;
  onToggle: (range: boolean) => void;
  onActivate: () => void;
  onConfigure: () => void;
  onPreview: (origin: HTMLElement) => void;
}

/**
 * Строка канала: клик выбирает (Shift — диапазон), «Настроить» открывает свои
 * настройки записи. Кнопки внутри убраны из Tab-порядка: их заменяют P и S.
 */
function ChannelRow(props: ChannelRowProps) {
  const { row, index, common, own, selected, focused, tabbable, meta, onToggle, onActivate, onConfigure, onPreview } = props;
  const { t } = useTranslation();
  const clip = own ? clipWindow(row, own) : null;
  const length = row.durationSeconds ?? 0;
  const strip =
    clip && length > 0 && (clip.from > 0 || clip.to < length)
      ? { left: `${(clip.from / length) * 100}%`, width: `${((clip.to - clip.from) / length) * 100}%` }
      : null;
  const duration = row.duration && row.duration !== "-" ? row.duration : null;
  const kind = kindLabel(row.kind, t);

  return (
    <div
      role="option"
      aria-selected={selected}
      data-row-id={row.id}
      tabIndex={tabbable ? 0 : -1}
      className={cn(styles.item, selected && styles.itemSelected, focused && styles.itemFocused)}
      style={{ animationDelay: `${Math.min(index, 12) * 25}ms` }}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onActivate();
      }}
      onMouseDown={(event) => {
        // Shift+клик не должен выделять текст между строками.
        if (event.shiftKey) event.preventDefault();
      }}
      onClick={(event) => {
        onActivate();
        onToggle(event.shiftKey);
      }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className={styles.check}
        onClick={(event) => {
          event.stopPropagation();
          onActivate();
          onToggle(event.shiftKey);
        }}
      >
        <RedesignIcon name="check" className="size-3" strokeWidth={3.5} />
      </button>
      <span className={styles.thumbBox} data-thumb>
        <RemoteImage
          className={styles.thumb}
          src={row.thumbnailUrl}
          alt=""
          fallbackLabel={row.kind === "recovered" ? t("simple.deleted_thumb", "удалено") : null}
          platform={row.platform}
        />
        {row.kind === "live" && <i className={styles.recDot} />}
        {row.kind !== "live" && duration && (
          <span className={styles.duration}>{row.kind === "recovered" ? `≈ ${duration}` : duration}</span>
        )}
        {strip && <i className={styles.thumbWindow} style={strip} />}
        {row.url && <PlayButton onPlay={onPreview} focusable={false} />}
      </span>
      <span className={styles.itemText}>
        <span className={styles.itemTitle}>{row.title}</span>
        {own ? (
          <span className={styles.custom}>
            <span className={styles.metaKind}>{kind}</span>
            {strip && (
              <span className={styles.customStrip}>
                <i style={strip} />
              </span>
            )}
            <span>{overrideSummary(common, row, own)}</span>
          </span>
        ) : (
          <span className={styles.itemMeta}>
            <span className={styles.metaKind}>{kind} · </span>
            {meta}
          </span>
        )}
      </span>
      <span className={styles.itemSide}>
        <span className={cn(styles.tag, styles[`tag_${row.kind}`])}>{kind}</span>
        <button
          type="button"
          tabIndex={-1}
          className={own ? styles.own : styles.gear}
          title={t("simple.own_title", "Свои настройки этой записи")}
          aria-keyshortcuts="S"
          onClick={(event) => {
            event.stopPropagation();
            onConfigure();
          }}
        >
          {own ? t("simple.own_badge", "свои") : t("simple.configure", "Настроить")}
        </button>
      </span>
    </div>
  );
}

interface DetailProps {
  link: LinkInfo;
  row: SearchRow;
  warnings: string[];
  submitting: boolean;
  directory: string;
  active: boolean;
  initialStart?: string;
  /** Возвращает id строк, которые встали в очередь. */
  onQueue: (rows: SearchRow[], options: QueueOptions) => Promise<string[]>;
}

/**
 * Одна запись, клип или эфир: превью и фрагмент слева, параметры справа.
 * Набор опций зависит от платформы и типа ссылки.
 */
export function SingleDetail({ link, row, warnings, submitting, directory, active, initialStart, onQueue }: DetailProps) {
  const { t, i18n } = useTranslation();
  const { draft, patch, chooseFolder, toQueueOptions } = useDownloadDraft(row.title, directory, initialStart);
  const qualities = useMemo(() => pickQualities(row.qualities), [row.qualities]);
  const live = row.kind === "live";
  const action = live
    ? draft.liveCapture === "range" && row.liveArchive
      ? t("simple.download_range", "Скачать отрезок")
      : t("simple.record_live", "Записать эфир")
    : link.actionLabel;
  const describeRow = (item: SearchRow) => describe(item, t, i18n.language);
  const liveRange = live && draft.liveCapture === "range" && Boolean(row.liveArchive);
  // Отрезок эфира качается из записи, а у записи Twitch чат есть.
  const chatPossible = link.supportsChat && (liveRange || (row.chatAvailable && !live));
  const [preview, openPreview] = useMediaPreview(describeRow, {
    onMarkStart: (_row, sec) => patch(markStartPatch(sec, draft.end)),
    onMarkEnd: (_row, sec) => patch(markEndPatch(sec, draft.start)),
    getRangeInfo: () => ({
      start: draft.start,
      end: draft.end,
      extraCount: draft.extraRanges.filter((r) => r.start.trim() || r.end.trim()).length,
    }),
    onAddExtraRange: !live
      ? () => {
          if (!draft.start && !draft.end) return;
          patch({
            extraRanges: [...draft.extraRanges, { id: crypto.randomUUID(), start: draft.start, end: draft.end }],
            start: "",
            end: "",
          });
        }
      : undefined,
  });

  const submit = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    void onQueue([row], toQueueOptions({ chatPossible, single: true }));
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (otherModalOpen()) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !submitting) {
        event.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className={styles.split}>
      {preview}
      <section className={styles.detail}>
        <span className={styles.detailMedia}>
          <RemoteImage
            className={styles.detailThumb}
            src={row.thumbnailUrl}
            alt=""
            platform={row.platform}
            fallbackLabel={link.platformLabel}
          />
          {live && <i className={styles.recDot} />}
          {row.url && <PlayButton large onPlay={(origin) => openPreview(row, origin)} />}
        </span>
        <div className={styles.detailHead}>
          <span className={cn(styles.tag, styles[`tag_${row.kind}`])}>{live ? kindLabel("live", t) : link.typeLabel}</span>
          <h3 className={styles.detailTitle}>{row.title}</h3>
          <p className={styles.itemMeta}>{describeRow(row)}</p>
        </div>
        <ClipFields
          draft={draft}
          patch={patch}
          live={live}
          length={row.durationSeconds}
          initialStart={initialStart}
          liveArchive={row.liveArchive}
        />
      </section>

      <aside className={styles.inspector}>
        {(qualities.length > 0 || link.supportsAudioOnly) && (
          <QualityPicker draft={draft} patch={patch} qualities={qualities} audio={link.supportsAudioOnly && !live} />
        )}

        <DownloadOptions
          link={link}
          draft={draft}
          patch={patch}
          chooseFolder={() => void chooseFolder()}
          chatPossible={chatPossible}
          live={live && !liveRange}
        />

        {warnings.map((warning) => (
          <p key={warning} className={styles.warning}>
            {warning}
          </p>
        ))}

        <div className={styles.footer}>
          <button
            type="button"
            className={styles.primary}
            disabled={submitting}
            onClick={submit}
          >
            <RedesignIcon name={live ? "live" : "download"} className="size-4" />
            {submitting ? t("simple.queueing", "Ставлю в очередь…") : action}
          </button>
        </div>
      </aside>
    </div>
  );
}

/** Плеер поверх окна для одной записи: узел для разметки и функция открытия. */
function useMediaPreview(describeRow: (row: SearchRow) => string, handlers?: {
  onMarkStart?: (row: SearchRow, seconds: number) => void;
  onMarkEnd?: (row: SearchRow, seconds: number) => void;
  getRangeInfo?: (row: SearchRow) => { start?: string; end?: string; extraCount?: number };
  onAddExtraRange?: (row: SearchRow) => void;
}): [ReactNode, (row: SearchRow, origin: HTMLElement) => void] {
  const [state, setState] = useState<{ target: MediaPreviewTarget; row: SearchRow } | null>(null);
  const open = (row: SearchRow, origin: HTMLElement) => {
    if (!row.url) return;
    setState({
      row,
      target: {
        url: row.url,
        platform: row.platform,
        title: row.title,
        subtitle: describeRow(row),
        thumbnailUrl: row.thumbnailUrl,
        live: row.kind === "live",
        origin,
      },
    });
  };
  const rangeInfo = state ? handlers?.getRangeInfo?.(state.row) : undefined;
  const node = state ? (
    <MediaPreviewOverlay
      target={state.target}
      onClose={() => setState(null)}
      onMarkStart={handlers?.onMarkStart ? (sec) => handlers.onMarkStart?.(state.row, sec) : undefined}
      onMarkEnd={handlers?.onMarkEnd ? (sec) => handlers.onMarkEnd?.(state.row, sec) : undefined}
      currentStart={rangeInfo?.start}
      currentEnd={rangeInfo?.end}
      extraCount={rangeInfo?.extraCount}
      onAddExtraRange={handlers?.onAddExtraRange ? () => handlers.onAddExtraRange?.(state.row) : undefined}
    />
  ) : null;
  return [node, open];
}

/** Кнопка «Смотреть» поверх миниатюры; клик не выбирает строку. */
function PlayButton({
  onPlay,
  large,
  focusable = true,
}: {
  onPlay: (origin: HTMLElement) => void;
  large?: boolean;
  /** В строке списка кнопку заменяет клавиша P, из Tab-порядка она убрана. */
  focusable?: boolean;
}) {
  const { t } = useTranslation();
  const play = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const box = event.currentTarget.parentElement;
    if (box) onPlay(box);
  };
  const label = t("simple.watch", "Смотреть");
  return (
    <button
      type="button"
      className={cn(styles.play, large && styles.playLarge)}
      onClick={play}
      aria-label={label}
      title={label}
      tabIndex={focusable ? undefined : -1}
      aria-keyshortcuts={focusable ? undefined : "P"}
    >
      <RedesignIcon name="play" className={large ? "size-5" : "size-3.5"} />
    </button>
  );
}

/** Поверх «Скачать» открыт другой модальный диалог (плеер, обновление): хоткеи окна молчат. */
function otherModalOpen(): boolean {
  return document.querySelectorAll('[role="dialog"][aria-modal="true"]').length > 1;
}

const FILTERS: Filter[] = ["all", "live", "vod", "clip", "recovered"];

function filterLabel(filter: Filter, t: TFunction): string {
  switch (filter) {
    case "all":
      return t("simple.filter_all", "Все");
    case "live":
      return t("simple.filter_live", "Эфир");
    case "vod":
      return t("simple.filter_vod", "Записи");
    case "clip":
      return t("simple.filter_clip", "Клипы");
    case "recovered":
      return t("simple.filter_recovered", "Удалённые");
  }
}

function kindLabel(kind: SearchRowKind, t: TFunction): string {
  switch (kind) {
    case "live":
      return t("simple.kind_live", "Эфир");
    case "vod":
      return t("simple.kind_vod", "Запись");
    case "clip":
      return t("simple.kind_clip", "Клип");
    case "recovered":
      return t("simple.kind_recovered", "Удалена");
  }
}

function describe(row: SearchRow, t: TFunction, locale: string): string {
  const parts: string[] = [];
  if (row.createdAt) {
    const date = new Date(row.createdAt);
    if (!Number.isNaN(date.getTime())) {
      parts.push(date.toLocaleDateString(locale, { day: "numeric", month: "short" }));
    }
  }
  if (row.kind !== "live" && row.duration && row.duration !== "-") parts.push(row.duration);
  if (row.chatAvailable) parts.push(t("simple.has_chat", "есть чат"));
  return parts.join(" · ") || row.username;
}
