import { useNavigate } from "@tanstack/react-router";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useGsapPresence } from "@/hooks/useGsapPresence";
import { backdropDismiss } from "@/lib/backdrop";
import { parseUrlStartTime } from "@/lib/timecode";
import { cn } from "@/lib/utils";
import { formatYtdlpError, type ErrorAction, type FriendlyError } from "@/lib/ytdlpErrors";
import { classifyLink } from "@/services/streams/linkKind";
import { queueSelection, type QueueOptions } from "@/services/streams/streamDownload";
import { searchStreams, type SearchHint, type SearchOutcome, type SearchRow } from "@/services/streams/streamSearch";
import { useDownloadHistory } from "@/stores/downloadHistory";
import { useSettings } from "@/stores/settings";
import { useUI } from "@/stores/ui";
import { PlatformIcon, RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { fetchrThemeClassName } from "@/ui/redesign/theme";
import { modalIn, modalOut } from "@/ui/redesign/theme/gsapMotion";
import { DUR, EASE, gsap, prefersReducedMotion } from "@/ui/redesign/theme/gsapSetup";

import { BatchQueue } from "./BatchQueue";
import styles from "./DownloadOverlay.module.css";
import { ChannelResults, SingleDetail } from "./DownloadResults";
import { extractUrls, looksLikeUrl, shortUrl } from "./linkInput";
import { showQueuedToast } from "./queueToast";
import { RecentLinks } from "./RecentLinks";
import { formatClock } from "./rowOverrides";
import { TrackerM3u8Tool } from "./TrackerM3u8Tool";
import { useLinkFileDrop } from "./useLinkFileDrop";

type Phase = "idle" | "loading" | "results" | "error" | "batch";

const ERROR_ID = "download-overlay-error";
const NOTE_ID = "download-overlay-note";

/**
 * Скачивание в простом режиме. Окно поверх приложения: сверху поиск, после
 * ссылки окно раскрывается в список слева и инспектор параметров справа.
 */
export function DownloadOverlay() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const open = useUI((s) => s.downloadOpen);
  const close = useUI((s) => s.closeDownload);
  const consumeDownloadPrefill = useUI((s) => s.consumeDownloadPrefill);
  const directory = useSettings((s) => s.directory);
  const remember = useDownloadHistory((s) => s.remember);
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef(0);
  const lastQuery = useRef("");
  const lastHint = useRef<SearchHint | null>(null);
  const lastQueue = useRef<{ rows: SearchRow[]; options: QueueOptions } | null>(null);
  const flipFrom = useRef<DOMRect | null>(null);
  const flipTween = useRef<gsap.core.Tween | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const { shouldRender, ref: cardRef } = useGsapPresence<HTMLDivElement>(open, (element, direction) =>
    direction === "in" ? modalIn(backdropRef.current, element) : modalOut(backdropRef.current, element),
  );

  const [query, setQuery] = useState("");
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [queueError, setQueueError] = useState<BannerError | null>(null);
  const [resultsAt, setResultsAt] = useState<number | null>(null);
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [batchUrls, setBatchUrls] = useState<string[]>([]);
  const [batchKey, setBatchKey] = useState(0);
  const [clipSuggestion, setClipSuggestion] = useState<string[] | null>(null);

  // Исходный прямоугольник FLIP снимается только перед сменой раскрытия,
  // а не на каждом коммите: getBoundingClientRect форсирует раскладку.
  const changePhase = (next: Phase) => {
    if (isExpanded(next) !== isExpanded(phaseRef.current)) {
      flipFrom.current = open ? (cardRef.current?.getBoundingClientRect() ?? null) : null;
    }
    phaseRef.current = next;
    setPhaseState(next);
  };

  useEffect(() => {
    if (!pasteNote) return;
    const timer = window.setTimeout(() => setPasteNote(null), PASTE_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [pasteNote]);

  const reset = () => {
    requestRef.current += 1;
    setQuery("");
    changePhase("idle");
    setOutcome(null);
    setError(null);
    setQueueError(null);
    setResultsAt(null);
    setPasteNote(null);
    setBatchUrls([]);
    inputRef.current?.focus();
  };

  const closeOverlay = close;
  const openQueue = () => {
    closeOverlay();
    void navigate({ to: "/queue" });
  };

  useEffect(() => {
    if (!open && !shouldRender && phase === "error") reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shouldRender, phase]);

  const startBatch = (urls: string[]) => {
    requestRef.current += 1;
    setClipSuggestion(null);
    setPasteNote(null);
    setError(null);
    setQuery("");
    setBatchUrls(urls);
    setBatchKey((key) => key + 1);
    changePhase("batch");
  };

  const runSearch = async (value: string, hint: SearchHint | null = null) => {
    const text = value.trim();
    if (!text) return;
    const seq = ++requestRef.current;
    lastQuery.current = text;
    lastHint.current = hint;
    changePhase("loading");
    setError(null);
    setQueueError(null);
    setPasteNote(null);
    setClipSuggestion(null);
    try {
      const state = useSettings.getState();
      const result = await searchStreams(text, {
        proxy: state.proxy,
        binariesDir: state.binariesDir,
        twitchAuthToken: state.integrations.twitchAuthToken || null,
        hint,
      });
      if (seq !== requestRef.current) return;
      setOutcome(result);
      setResultsAt(Date.now());
      changePhase("results");
      if (!hint && (result.rows.length > 0 || result.link.listing)) {
        remember({
          query: text,
          platform: result.link.platform,
          label: result.link.listing ? (result.link.login ?? shortUrl(text)) : (result.rows[0]?.title ?? shortUrl(text)),
          typeLabel: result.link.typeLabel,
        });
      }
    } catch (reason) {
      if (seq !== requestRef.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      changePhase("error");
    }
  };

  const openText = (text: string) => {
    const urls = extractUrls(text);
    if (urls.length > 1) {
      startBatch(urls);
      return;
    }
    const single = urls[0] ?? text.trim();
    setQuery(single);
    void runSearch(single);
  };

  useLinkFileDrop((urls) => {
    if (!useUI.getState().downloadOpen) useUI.getState().openDownload();
    openText(urls.join("\n"));
  });

  useEffect(() => {
    if (!open) return;
    const prefill = consumeDownloadPrefill();
    if (prefill) {
      openText(prefill);
    } else if (phase === "idle" && !query.trim()) {
      void suggestFromClipboard();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("select, details[open], [data-esc-local]")) return;
      if (document.querySelectorAll('[role="dialog"][aria-modal="true"]').length > 1) return;
      closeOverlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Ссылка в буфере видна сразу при открытии: один клик вместо Ctrl+V.
  const suggestFromClipboard = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      const urls = extractUrls(text);
      const found = urls.length > 0 ? urls : looksLikeUrl(text) ? [text] : [];
      const fresh = found.length > 1 || (found[0] && found[0] !== lastQuery.current);
      setClipSuggestion(fresh ? found : null);
    } catch {
      setClipSuggestion(null);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void runSearch(query);
  };

  // Вставка ссылки уже и есть запрос: кнопку «Найти» нажимать не нужно.
  // Несколько ссылок разом уходят в пакетную очередь.
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text").trim();
    const urls = extractUrls(pasted);
    if (urls.length > 1) {
      event.preventDefault();
      startBatch(urls);
      return;
    }
    if (!looksLikeUrl(pasted)) return;
    const input = event.currentTarget;
    const wholeSelected = input.selectionStart === 0 && input.selectionEnd === input.value.length;
    if (input.value.trim() && !wholeSelected) return;
    event.preventDefault();
    setQuery(pasted);
    void runSearch(pasted);
  };

  const pasteFromClipboard = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        setPasteNote(t("simple.clipboard_empty", "В буфере обмена нет текста. Скопируй ссылку и попробуй снова."));
        return;
      }
      openText(text);
    } catch {
      setPasteNote(t("simple.clipboard_denied", "Нет доступа к буферу обмена. Вставь ссылку в поле через Ctrl+V."));
    }
  };

  /** Ставит строки в очередь и возвращает id строк, которые встали. */
  const onQueue = async (rows: SearchRow[], options: QueueOptions): Promise<string[]> => {
    setSubmitting(true);
    setQueueError(null);
    lastQueue.current = { rows, options };
    try {
      const result = await queueSelection(rows, options);
      if (result.queued > 0) showQueuedToast(result.jobIds, openQueue);
      const failedIds = new Set(result.failed.map((item) => item.row.id));
      if (result.failed.length > 0) {
        // Повтор берёт только упавшие строки: удачные уже стоят в очереди.
        lastQueue.current = { rows: result.failed.map((item) => item.row), options };
        setQueueError(queueFailure(result.failed, t));
      } else if (result.queued > 0 && !outcome?.link.listing) {
        reset();
      }
      return rows.filter((row) => !failedIds.has(row.id)).map((row) => row.id);
    } catch (reason) {
      setQueueError(toBannerError(formatYtdlpError(reason), t));
      return [];
    } finally {
      setSubmitting(false);
    }
  };

  const retryQueue = () => {
    const last = lastQueue.current;
    if (last && !submitting) void onQueue(last.rows, last.options);
  };

  const openSettings = (action: ErrorAction) => {
    useUI.getState().setPendingSettingsTab(SETTINGS_TAB[action]);
    closeOverlay();
    void navigate({ to: "/settings" });
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowDown" || query.trim()) return;
    const first = trapRef.current?.querySelector<HTMLElement>("[data-recent-item]");
    if (!first) return;
    event.preventDefault();
    first.focus();
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes("text/uri-list") || event.dataTransfer.types.includes("text/plain")) {
      event.preventDefault();
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const text = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    if (!text.trim()) return;
    event.preventDefault();
    openText(text);
  };

  const expanded = isExpanded(phase);

  // FLIP раскрытия: карточка сразу встаёт в новый размер, а transform
  // доигрывает путь от старого прямоугольника. Раскладка считается один раз,
  // а не на каждом кадре, как при переходе width/height.
  useLayoutEffect(() => {
    const card = cardRef.current;
    const from = flipFrom.current;
    flipFrom.current = null;
    if (!card || !from || from.width === 0 || prefersReducedMotion()) return;
    // Идёт вход/выход модалки (prefill, drop): FLIP поверх него дал бы скачок
    // прозрачности и неверный исходный прямоугольник — карточка просто встаёт.
    const ownTweenActive = flipTween.current?.isActive() ?? false;
    if (gsap.isTweening(card) && !ownTweenActive) return;
    flipTween.current?.kill();
    gsap.set(card, { opacity: 1, clearProps: "transform,transformOrigin" });
    const to = card.getBoundingClientRect();
    if (to.width === 0 || to.height === 0) return;
    gsap.set(card, { transformOrigin: "top left" });
    flipTween.current = gsap.fromTo(
      card,
      {
        x: from.left - to.left,
        y: from.top - to.top,
        scaleX: from.width / to.width,
        scaleY: from.height / to.height,
        opacity: 0.85,
      },
      {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        duration: DUR.slow,
        ease: EASE.out,
        clearProps: "transform,transformOrigin,opacity",
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  useEffect(
    () => () => {
      flipTween.current?.kill();
    },
    [],
  );

  const keepMountedInBackground = (phase === "results" && outcome !== null) || phase === "batch";
  if (!shouldRender && !keepMountedInBackground) return null;

  const link = outcome?.link ?? null;
  const placeholder = t("simple.placeholder", "Ссылка на стримера, запись или клип");
  const searched = expanded && query.trim() === lastQuery.current;
  const urlStartSec = parseUrlStartTime(lastQuery.current);
  const initialStart = urlStartSec ? formatClock(urlStartSec) : "";
  const loadingListing = phase === "loading" && classifyLink(lastQuery.current).listing;
  const describedBy = phase === "error" && error ? ERROR_ID : pasteNote ? NOTE_ID : undefined;
  const showIdleExtras = phase === "idle" && !query.trim();

  return (
    <div
      ref={backdropRef}
      className={cn(fetchrThemeClassName, styles.overlay)}
      style={!shouldRender ? { display: "none" } : undefined}
      {...backdropDismiss(closeOverlay)}
      role="presentation"
    >
      <div
        ref={(node) => {
          cardRef.current = node;
          trapRef.current = node;
        }}
        className={styles.card}
        data-expanded={expanded || undefined}
        onClick={(event) => event.stopPropagation()}
        onDragOver={onDragOver}
        onDrop={onDrop}
        role="dialog"
        aria-modal="true"
        aria-label={t("nav.download", "Скачать")}
      >
        <form className={styles.searchBar} onSubmit={onSubmit} role="search">
          <div className={styles.field}>
            {/* Во время загрузки прогресс показывают скелетоны, второй спиннер в поле не нужен. */}
            <RedesignIcon name="finder" className={styles.fieldIcon} />
            <input
              ref={inputRef}
              className={styles.fieldInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onPaste={onPaste}
              onKeyDown={onInputKeyDown}
              placeholder={placeholder}
              aria-label={placeholder}
              aria-invalid={phase === "error" || undefined}
              aria-describedby={describedBy}
              spellCheck={false}
              autoFocus
            />
            {query && (
              <button
                type="button"
                className={styles.clearButton}
                onClick={() => {
                  if (phase !== "idle") {
                    reset();
                  } else {
                    setQuery("");
                  }
                }}
                aria-label={t("simple.clear", "Очистить")}
                title={t("simple.clear", "Очистить")}
              >
                <RedesignIcon name="close" className="size-3.5" />
              </button>
            )}
            {link && searched && phase !== "loading" ? (
              <span className={styles.platformChip}>
                <PlatformIcon platform={link.platform} className="size-3.5" />
                {link.platformLabel} · {link.typeLabel}
              </span>
            ) : query.trim() ? (
              <button className={styles.findButton} type="submit" disabled={phase === "loading"}>
                {t("simple.find", "Найти")}
              </button>
            ) : (
              <button
                type="button"
                className={styles.kbd}
                onClick={() => void pasteFromClipboard()}
                title={t("simple.paste_title", "Вставить ссылку из буфера обмена")}
                aria-keyshortcuts="Control+V"
              >
                <RedesignIcon name="clipboard" className="size-3.5" />
                {t("simple.paste", "Вставить")}
                <kbd aria-hidden>Ctrl V</kbd>
              </button>
            )}
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={closeOverlay}
            aria-label={t("common.close", "Закрыть")}
            title={t("common.close", "Закрыть")}
          >
            <RedesignIcon name="close" className="size-4" />
          </button>
        </form>

        {pasteNote && (
          <p id={NOTE_ID} className={styles.pasteNote} role="status">
            {pasteNote}
          </p>
        )}

        {phase === "error" && error && (
          <ErrorBanner
            id={ERROR_ID}
            error={toBannerError(formatYtdlpError(error), t)}
            onRetry={() => void runSearch(lastQuery.current, lastHint.current)}
            onAction={openSettings}
          />
        )}

        {phase === "results" && resultsAt !== null && (
          <div className={styles.resultsStamp}>
            <span>
              {t("simple.results_at", "Результаты от {{time}}", {
                time: new Date(resultsAt).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" }),
              })}
            </span>
            <button
              type="button"
              className={styles.ghost}
              onClick={() => void runSearch(lastQuery.current)}
              disabled={submitting}
            >
              <RedesignIcon name="refresh" className="size-3.5" />
              {t("simple.refresh", "Обновить")}
            </button>
          </div>
        )}

        {showIdleExtras && clipSuggestion && clipSuggestion.length > 0 && (
          <div className={styles.clipRow}>
            <button
              type="button"
              className={styles.clipChip}
              onClick={() => (clipSuggestion.length > 1 ? startBatch(clipSuggestion) : openText(clipSuggestion[0]))}
            >
              <RedesignIcon name="clipboard" className="size-3.5" />
              <span className={styles.clipChipText}>
                {clipSuggestion.length > 1
                  ? t("simple.clip_many", "Вставить ссылки из буфера: {{count}}", { count: clipSuggestion.length })
                  : t("simple.clip_one", "Вставить {{url}}", { url: shortUrl(clipSuggestion[0]) })}
              </span>
            </button>
          </div>
        )}

        {(phase === "idle" || phase === "error") && (
          <div className={styles.intro}>
            <h1 className={styles.introTitle}>{t("simple.hero_title", "Вставь ссылку")}</h1>
            <p className={styles.introText}>
              {t("simple.hero_text", "Канал покажет эфир, записи и удалённые VOD. Ссылка на запись или клип откроет её параметры.")}
            </p>
            <div className={styles.platforms}>
              {(["twitch", "kick", "youtube", "vk"] as const).map((id) => (
                <span key={id}>
                  <PlatformIcon platform={id} className="size-3.5" />
                  {PLATFORM_NAME[id]}
                </span>
              ))}
            </div>
            <p className={styles.introHint}>
              {t("simple.hero_hint", "Можно вставить сразу несколько ссылок или перетащить файл .url / .txt на окно.")}
            </p>
          </div>
        )}

        {showIdleExtras && <RecentLinks onPick={(value) => openText(value)} inputRef={inputRef} />}

        {(phase === "idle" || phase === "error") && (
          <TrackerM3u8Tool
            onOpen={(url, hint) => {
              setQuery(url);
              void runSearch(url, hint);
            }}
          />
        )}

        {phase === "batch" && (
          <BatchQueue
            key={batchKey}
            urls={batchUrls}
            directory={directory}
            onDone={(jobIds) => showQueuedToast(jobIds, openQueue)}
            onCancel={reset}
            onOpen={(url) => openText(url)}
          />
        )}

        {phase === "loading" && (
          <>
            <p className={styles.loadingNote} role="status">
              {loadingListing
                ? t("simple.loading_channel", "Ищу эфир и записи канала…")
                : t("simple.loading_single", "Открываю ссылку…")}
            </p>
            <div className={styles.split} aria-busy>
              <div className={styles.listPane}>
                <div className={styles.list}>
                  {Array.from({ length: 6 }, (_, index) => (
                    <div key={index} className={styles.skeleton} style={{ animationDelay: `${index * 80}ms` }} aria-hidden />
                  ))}
                </div>
              </div>
              <div className={styles.inspector}>
                <div className={cn(styles.skeleton, styles.skeletonTall)} aria-hidden />
              </div>
            </div>
          </>
        )}

        {phase === "results" && queueError && (
          <ErrorBanner error={queueError} onRetry={submitting ? undefined : retryQueue} onAction={openSettings} />
        )}

        {phase === "results" && outcome && link && (
          <div style={{ display: "contents" }}>
            {link.listing ? (
              <ChannelResults
                key={lastQuery.current}
                link={link}
                rows={outcome.rows}
                warnings={outcome.warnings}
                submitting={submitting}
                directory={directory}
                active={open && phase === "results"}
                onQueue={onQueue}
              />
            ) : outcome.rows[0] ? (
              <SingleDetail
                key={outcome.rows[0].id || lastQuery.current}
                link={link}
                row={outcome.rows[0]}
                warnings={outcome.warnings}
                submitting={submitting}
                directory={directory}
                active={open && phase === "results"}
                initialStart={initialStart}
                onQueue={onQueue}
              />
            ) : (
              <div className={styles.done}>
                {outcome.warnings.length > 0 ? (
                  outcome.warnings.map((warning) => (
                    <p key={warning} className={styles.note}>
                      {warning}
                    </p>
                  ))
                ) : (
                  <>
                    <p className={styles.introTitle}>{t("simple.nothing_found", "Ничего не нашлось.")}</p>
                    <p className={styles.introText}>
                      {t("simple.nothing_found_hint", "Проверь ссылку или вставь ссылку на канал целиком: там видны эфир и все записи.")}
                    </p>
                  </>
                )}
                <button type="button" className={styles.secondary} onClick={reset}>
                  {t("simple.new_search", "Новый поиск")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Готовое к показу сообщение: уже переведено, повторно не разбирается. */
interface BannerError {
  message: string;
  action: ErrorAction | null;
  details: string | null;
}

function translatedMessage(info: FriendlyError, t: TFunction): string {
  return info.key ? t(`errors.${info.key}`, info.message) : info.message;
}

function toBannerError(info: FriendlyError, t: TFunction): BannerError {
  return { message: translatedMessage(info, t), action: info.action, details: info.details };
}

/** Одна ошибка — как есть; несколько — по строке на запись, действие первой, у которой оно есть. */
function queueFailure(failed: Array<{ row: SearchRow; reason: string }>, t: TFunction): BannerError {
  const infos = failed.map((item) => formatYtdlpError(item.reason));
  if (failed.length === 1) return toBannerError(infos[0], t);
  return {
    message: failed.map((item, index) => `${item.row.title}: ${translatedMessage(infos[index], t)}`).join("\n"),
    action: infos.find((info) => info.action !== null)?.action ?? null,
    details: null,
  };
}

interface ErrorBannerProps {
  id?: string;
  error: BannerError;
  /** Повтор последнего запроса; без него кнопки «Повторить» нет. */
  onRetry?: () => void;
  /** Переход в раздел настроек, который чинит именно эту ошибку. */
  onAction?: (action: ErrorAction) => void;
}

function ErrorBanner({ id, error, onRetry, onAction }: ErrorBannerProps) {
  const { t } = useTranslation();
  const action = error.action;
  const actionLabel: Record<ErrorAction, string> = {
    proxy: t("simple.error_action_proxy", "Настройки прокси"),
    twitch_auth: t("simple.error_action_twitch", "Подключить Twitch"),
    binaries: t("simple.error_action_binaries", "Компоненты"),
  };
  return (
    <div id={id} className={styles.error} role="alert" title={error.details ?? undefined}>
      <span className={styles.errorMessage}>{error.message}</span>
      {(onRetry || (action && onAction)) && (
        <div className={styles.errorActions}>
          {onRetry && (
            <button type="button" className={styles.errorAction} onClick={onRetry}>
              {t("common.retry", "Повторить")}
            </button>
          )}
          {action && onAction && (
            <button type="button" className={styles.errorAction} onClick={() => onAction(action)}>
              {actionLabel[action]}
            </button>
          )}
        </div>
      )}
      {error.details && (
        <details className={styles.errorDetails}>
          <summary>{t("simple.tech_details", "Технические детали")}</summary>
          <pre>{error.details}</pre>
        </details>
      )}
    </div>
  );
}

const PASTE_NOTE_MS = 4000;

const isExpanded = (phase: Phase) => phase === "loading" || phase === "results";

/** Вкладка настроек, где чинится ошибка данного типа. */
const SETTINGS_TAB: Record<ErrorAction, string> = {
  proxy: "network",
  twitch_auth: "integrations",
  binaries: "tools",
};

const PLATFORM_NAME = { twitch: "Twitch", kick: "Kick", youtube: "YouTube", vk: "VK" } as const;
