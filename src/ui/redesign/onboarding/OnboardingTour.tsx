import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { useSettings, usesSimpleContent } from "@/stores/settings";
import { isToolEnabled } from "@/ui/redesign/setup/setupTools";
import { fetchrThemeClassName } from "@/ui/redesign/theme";

import styles from "./OnboardingTour.module.css";

// ─── Steps ───────────────────────────────────────────────────────────────────

type TourSide = "top" | "bottom" | "bottom-left";

interface TourStep {
  /** i18n suffix: onboarding.steps.<key>.{title,description,tip} */
  key: string;
  /** value of the data-tour attribute on the highlighted element */
  target: string;
  title: string;
  description: string;
  tip?: string;
  navigateTo?: string;
  side?: TourSide;
}

const STEPS: TourStep[] = [
  {
    key: "queue",
    target: "nav-queue",
    title: "Очередь задач",
    description:
      "Главный раздел. Добавляй ссылки на VOD или стримы — Fetchr скачает, нарежет и обработает их. Поддерживает Twitch, Kick, YouTube и прямые M3U8-ссылки.",
    tip: "Ctrl+N — быстро добавить задачу",
    side: "bottom",
    navigateTo: "/queue",
  },
  {
    key: "queue_add",
    target: "queue-add",
    title: "Добавить задачу",
    description:
      "Открывает диалог добавления. Вставь ссылку, выбери качество, временной диапазон и пресет обработки. Можно добавить несколько диапазонов за раз.",
    tip: "Пресеты сохраняют набор настроек для повторного использования",
    side: "bottom",
  },
  {
    key: "queue_run",
    target: "queue-run",
    title: "Запустить очередь",
    description:
      "Запускает все задачи в очереди. Количество одновременных потоков настраивается в Настройках → Общие. Можно поставить на паузу во время работы.",
    tip: "Ctrl+Enter — запустить с клавиатуры",
    side: "bottom",
  },
  {
    key: "queue_filters",
    target: "queue-filters",
    title: "Фильтры задач",
    description:
      "Фильтруй задачи по статусу: Все, Активные, В очереди, Завершены, Ошибки. Вкладка «Ошибки» покажет задачи с описанием причины сбоя.",
    side: "bottom",
  },
  {
    key: "queue_clear",
    target: "queue-clear",
    title: "Очистить завершённые",
    description:
      "Удаляет завершённые задачи из списка. Файлы при этом не трогаются — они уже сохранены в рабочей папке.",
    side: "bottom",
  },
  {
    key: "live_recorder",
    target: "nav-live-recorder",
    title: "Запись стримов",
    description:
      "Автозапись live-трансляций. Добавь канал — Fetchr будет следить и начнёт запись, как только стример выйдет в эфир. Несколько каналов одновременно.",
    side: "bottom",
  },
  {
    key: "finder",
    target: "nav-finder",
    title: "M3U8 Finder",
    description:
      "Восстанавливает удалённые или «суб-только» VOD с Twitch через публичные трекеры. Введи никнейм стримера и дату — Fetchr проверит lossless.tv, Sullygnome и другие.",
    tip: "Найденные ссылки можно сразу добавить в очередь",
    side: "bottom",
  },
  {
    key: "chat_render",
    target: "nav-chat-render",
    title: "Рендер чата",
    description:
      "Скачивает чат Twitch/Kick и рендерит в видео с прозрачным фоном — идеально для наложения поверх записи. Настройка шрифтов, позиции, BetterTTV / FFZ / 7TV.",
    tip: "Экспорт в MOV с альфа-каналом для наложения в редакторе",
    side: "bottom",
  },
  {
    key: "sponsor_blur",
    target: "nav-sponsor-blur",
    title: "Блюр спонсоров",
    description:
      "Размывает логотипы и спонсорские зоны. Загрузи референс-кадр, отметь область — Fetchr применит блюр на всё видео автоматически.",
    side: "bottom",
  },
  {
    key: "fetchr_mute",
    target: "nav-fetchr-mute",
    title: "Удалить маты",
    description:
      "Автоматически находит и заглушает нецензурную лексику в аудио. Работает локально без интернета. Полезно для клипов на YouTube.",
    side: "bottom",
  },
  {
    key: "vocal_remover",
    target: "nav-vocal-remover",
    title: "Vocal Remover",
    description:
      "Разделяет аудио на вокал и инструментал с помощью нейросети Demucs / MDX. Получи чистый минус или изолированный вокал из любого видео.",
    side: "bottom",
  },
  {
    key: "logs",
    target: "nav-logs",
    title: "Логи",
    description:
      "Все ошибки, предупреждения и события приложения. Если задача упала с ошибкой — загляни сюда за подробностями. Фильтрация по уровню и источнику.",
    side: "bottom",
  },
  {
    key: "settings",
    target: "nav-settings",
    title: "Настройки",
    description:
      "Рабочая папка, потоки, прокси, пути к ffmpeg/yt-dlp, GPU-кодирование, интеграции Twitch/Kick, лицензия. Здесь же — Помощь & FAQ.",
    tip: "Ctrl+, — открыть настройки",
    side: "bottom-left",
  },
];

// ─── Constants ───────────────────────────────────────────────────────────────

const PAD = 10; // padding around the highlighted element
const GAP = 14; // gap between spotlight and tooltip
const TIP_W = 340; // preferred tooltip width
const EDGE = 12; // min distance to the viewport edge
const SETTLE_MS = 900; // re-measure at 60fps while the page transition runs
const MISSING_MS = 2200; // give up looking for the target
const POLL_MS = 250; // low-frequency safety net afterwards

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(Math.max(v, min), Math.max(min, max));

const sameRect = (a: Rect | null, b: Rect) =>
  !!a &&
  Math.abs(a.x - b.x) < 0.5 &&
  Math.abs(a.y - b.y) < 0.5 &&
  Math.abs(a.w - b.w) < 0.5 &&
  Math.abs(a.h - b.h) < 0.5;

// ─── Target tracking ─────────────────────────────────────────────────────────

/**
 * Resolves `[data-tour="<target>"]` and keeps its rect in sync.
 * Runs at 60fps only while the route transition settles, then falls back to
 * ResizeObserver + resize/scroll listeners + a cheap 250ms poll.
 */
function useTargetRect(target: string, stepIndex: number) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let poll = 0;
    let scrolled = false;
    let observed: HTMLElement | null = null;
    let ro: ResizeObserver | null = null;
    const startedAt = performance.now();

    const measure = () => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);

      if (!el) {
        observed = null;
        ro?.disconnect();
        setRect(null);
        if (performance.now() - startedAt > MISSING_MS) setMissing(true);
        return;
      }

      setMissing(false);

      if (observed !== el) {
        observed = el;
        ro?.disconnect();
        ro = new ResizeObserver(measure);
        ro.observe(el);
      }

      if (!scrolled) {
        scrolled = true;
        el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      }

      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        setRect(null);
        return;
      }
      const next: Rect = { x: r.left, y: r.top, w: r.width, h: r.height };
      setRect((prev) => (sameRect(prev, next) ? prev : next));
    };

    const tick = () => {
      if (cancelled) return;
      measure();
      const elapsed = performance.now() - startedAt;
      if ((observed && elapsed > SETTLE_MS) || elapsed > MISSING_MS) {
        poll = window.setInterval(measure, POLL_MS);
      } else {
        raf = requestAnimationFrame(tick);
      }
    };

    raf = requestAnimationFrame(tick);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearInterval(poll);
      ro?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [target, stepIndex]);

  return { rect, missing };
}

function useViewport() {
  const [vp, setVp] = useState(() => ({
    w: typeof window === "undefined" ? 1280 : window.innerWidth,
    h: typeof window === "undefined" ? 800 : window.innerHeight,
  }));
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return vp;
}

// ─── Placement ───────────────────────────────────────────────────────────────

interface Placement {
  style: CSSProperties;
  arrow: "up" | "down" | null;
  arrowLeft: number;
}

function computePlacement(
  spot: Rect | null,
  side: TourSide,
  vp: { w: number; h: number },
  bubble: { w: number; h: number },
): Placement {
  const width = Math.min(TIP_W, vp.w - EDGE * 2);

  if (!spot) {
    return {
      style: { top: "50%", left: "50%", transform: "translate(-50%, -50%)", width },
      arrow: null,
      arrowLeft: 0,
    };
  }

  const bh = bubble.h || 190;
  const fitsBelow = spot.y + spot.h + GAP + bh <= vp.h - EDGE;
  const fitsAbove = spot.y - GAP - bh >= EDGE;
  const placeBelow = side === "top" ? !fitsAbove && fitsBelow : fitsBelow || !fitsAbove;

  const rawLeft =
    side === "bottom-left"
      ? spot.x + spot.w - width
      : spot.x + spot.w / 2 - width / 2;
  const left = clamp(rawLeft, EDGE, vp.w - width - EDGE);

  const idealTop = placeBelow ? spot.y + spot.h + GAP : spot.y - GAP - bh;
  const top = clamp(idealTop, EDGE, Math.max(EDGE, vp.h - bh - EDGE));

  // Hide the arrow when the bubble had to be pushed away from the spotlight.
  const anchored = Math.abs(top - idealTop) < 1;
  const arrowLeft = clamp(spot.x + spot.w / 2 - left - 7, 14, width - 28);

  return {
    style: { top, left, width },
    arrow: anchored ? (placeBelow ? "up" : "down") : null,
    arrowLeft,
  };
}

/** Шаг «nav-<инструмент>» показывается, только если инструмент есть в навигации. */
export function tourStepsFor(enabledTools: string[] | null, simple: boolean): TourStep[] {
  return STEPS.filter((item) => {
    if (!item.target.startsWith("nav-")) return true;
    const tool = item.target.slice("nav-".length);
    if (tool === "queue" || tool === "settings" || tool === "logs") return true;
    if (tool === "finder" && simple) return false;
    return isToolEnabled(enabledTools, tool);
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export interface OnboardingTourProps {
  onClose: () => void;
  onNavigate: (path: string) => void;
}

export function OnboardingTour({ onClose, onNavigate }: OnboardingTourProps) {
  const { t } = useTranslation();
  const setDone = useSettings((s) => s.setOnboardingCompleted);

  const enabledTools = useSettings((s) => s.enabledTools);
  const simple = usesSimpleContent(useSettings((s) => s.uiMode));
  // Гайд идёт только по включённым инструментам: выбран один «Удалить маты» —
  // шагов про блюр спонсоров и рендер чата нет.
  const steps = useMemo(() => tourStepsFor(enabledTools, simple), [enabledTools, simple]);

  const [step, setStep] = useState(0);
  const index = clamp(step, 0, steps.length - 1);
  const cur = steps[index];
  const isLast = index === steps.length - 1;

  const bubbleRef = useRef<HTMLDivElement>(null);
  const [bubbleSize, setBubbleSize] = useState({ w: TIP_W, h: 0 });

  const { rect, missing } = useTargetRect(cur.target, index);
  const vp = useViewport();

  // Keep the latest navigate callback without re-firing the effect on every render.
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  useEffect(() => {
    if (cur.navigateTo) navigateRef.current(cur.navigateTo);
  }, [cur.navigateTo]);

  // Measure the bubble so placement can flip when it does not fit.
  useEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setBubbleSize((prev) =>
        Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5
          ? prev
          : { w: r.width, h: r.height },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Lock background scrolling for the duration of the tour.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const finish = useCallback(() => {
    setDone(true);
    onClose();
  }, [onClose, setDone]);

  const goNext = useCallback(() => {
    if (index >= steps.length - 1) {
      finish();
      return;
    }
    setStep(index + 1);
  }, [finish, index]);

  const goPrev = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);

  // Keyboard: Esc / arrows / Enter. Capture phase so global app hotkeys stay inert.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish();
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        goNext();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        goPrev();
        return;
      }
      if (e.key === "Enter" && document.activeElement === bubbleRef.current) {
        e.preventDefault();
        e.stopPropagation();
        goNext();
        return;
      }
      if (e.key === "Tab") {
        const root = bubbleRef.current;
        if (!root) return;
        const focusable = root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === root)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      // Swallow application shortcuts (Ctrl+N, Ctrl+K, g-navigation, …).
      if (e.ctrlKey || e.metaKey || e.altKey) e.stopPropagation();
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [finish, goNext, goPrev]);

  // Move focus into the bubble on every step so screen readers announce it.
  useEffect(() => {
    bubbleRef.current?.focus({ preventScroll: true });
  }, [index]);

  const spot: Rect | null = rect
    ? { x: rect.x - PAD, y: rect.y - PAD, w: rect.w + PAD * 2, h: rect.h + PAD * 2 }
    : null;

  const placement = useMemo(
    () => computePlacement(spot, cur.side ?? "bottom", vp, bubbleSize),
    [spot?.x, spot?.y, spot?.w, spot?.h, cur.side, vp.w, vp.h, bubbleSize.h, bubbleSize.w],
  );

  const tr = (field: "title" | "description" | "tip", fallback: string) =>
    t(`onboarding.steps.${cur.key}.${field}`, fallback);

  return (
    <div
      className={`${fetchrThemeClassName} ${styles.root}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("onboarding.aria_label", "Обучение Fetchr")}
    >
      {/* Backdrop — blocks the app but never closes the tour by accident */}
      <div className={styles.backdrop} aria-hidden />

      {/*
        Dim is composed of four panels around the spotlight instead of a single
        `box-shadow: 0 0 0 9999px`. WebView2 rasterises huge shadow spreads as an
        opaque black rectangle, which blacked out the whole window.
      */}
      {spot ? (
        <>
          <div
            className={styles.dimPart}
            aria-hidden
            style={{ left: 0, right: 0, top: 0, height: Math.max(0, spot.y) }}
          />
          <div
            className={styles.dimPart}
            aria-hidden
            style={{ left: 0, right: 0, top: Math.max(0, spot.y + spot.h), bottom: 0 }}
          />
          <div
            className={styles.dimPart}
            aria-hidden
            style={{
              left: 0,
              width: Math.max(0, spot.x),
              top: Math.max(0, spot.y),
              height: Math.max(0, spot.h),
            }}
          />
          <div
            className={styles.dimPart}
            aria-hidden
            style={{
              left: Math.max(0, spot.x + spot.w),
              right: 0,
              top: Math.max(0, spot.y),
              height: Math.max(0, spot.h),
            }}
          />
          <div
            className={styles.ring}
            aria-hidden
            style={{ left: spot.x, top: spot.y, width: spot.w, height: spot.h }}
          />
        </>
      ) : (
        <div className={styles.dim} aria-hidden />
      )}

      <div
        ref={bubbleRef}
        className={styles.bubble}
        tabIndex={-1}
        style={placement.style}
        onClick={(e) => e.stopPropagation()}
      >
        {placement.arrow && (
          <div
            className={`${styles.arrow} ${placement.arrow === "down" ? styles.arrowDown : ""}`}
            style={{ left: placement.arrowLeft }}
            aria-hidden
          />
        )}

        <div className={styles.topRow}>
          <div className={styles.dots} role="tablist" aria-label={t("onboarding.steps_label", "Шаги")}>
            {steps.map((s, i) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={`${i + 1}. ${t(`onboarding.steps.${s.key}.title`, s.title)}`}
                title={t(`onboarding.steps.${s.key}.title`, s.title)}
                className={`${styles.dot} ${i === index ? styles.dotActive : ""}`}
                onClick={() => setStep(i)}
              />
            ))}
          </div>
          <span className={styles.counter}>
            {index + 1} / {steps.length}
          </span>
        </div>

        <div className={styles.progress} aria-hidden>
          <div
            className={styles.progressFill}
            style={{ width: `${((index + 1) / steps.length) * 100}%` }}
          />
        </div>

        <h2 className={styles.title}>{tr("title", cur.title)}</h2>
        <p className={styles.desc}>{tr("description", cur.description)}</p>

        {cur.tip && (
          <div className={styles.tip}>
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{ flexShrink: 0, marginTop: 2 }}
              aria-hidden
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            {tr("tip", cur.tip)}
          </div>
        )}

        {missing && (
          <div className={styles.warn}>
            {t(
              "onboarding.target_missing",
              "Этот элемент сейчас недоступен — он появится, когда раздел будет открыт.",
            )}
          </div>
        )}

        <div className={styles.nav}>
          <button className={styles.btnSkip} type="button" onClick={finish}>
            {t("onboarding.skip", "Пропустить")}
          </button>
          <div className={styles.navRight}>
            {index > 0 && (
              <button className={styles.btnBack} type="button" onClick={goPrev}>
                ← {t("onboarding.back", "Назад")}
              </button>
            )}
            <button className={styles.btnNext} type="button" onClick={goNext}>
              {isLast ? `${t("onboarding.done", "Готово")} ✓` : `${t("onboarding.next", "Далее")} →`}
            </button>
          </div>
        </div>

        <div className={styles.hint} aria-hidden>
          {t("onboarding.kbd_hint", "← → — навигация, Esc — выйти")}
        </div>
      </div>
    </div>
  );
}
