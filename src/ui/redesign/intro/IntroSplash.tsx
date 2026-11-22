import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { useBoot, type BootPhase } from "@/stores/boot";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { Flip, gsap, useGSAP } from "@/ui/redesign/theme/gsapSetup";

import { ActivationPanel } from "./ActivationPanel";
import { createAsciiBackdrop } from "./asciiBackdrop";
import { BootStatus } from "./BootStatus";
import { BrandWordmark } from "@/ui/redesign/brand/FetchrBrand";

import { buildDevelop } from "./introDevelop";
import { IntroMark } from "./IntroMark";
import styles from "./IntroSplash.module.css";
import {
  buildCardOut,
  buildEntrance,
  buildExit,
  buildIdle,
  buildReentry,
  buildRise,
  buildSettle,
  collectParts,
  EXIT_LABEL,
  findAnchors,
  waitForAnchors,
  type IntroParts,
} from "./introTimeline";

/** Пока атрибут стоит на <html>, знак и имя в топбаре скрыты: их место займёт прилетающий локап */
const INTRO_ATTR = "data-fetchr-intro";
/** Страховка: вход обязан доиграть, даже если таймлайн встал */
const SAFETY_MS = 8000;
/** Страховка ухода: приложение не должно остаться под заставкой */
const EXIT_SAFETY_MS = 4000;
/** Сколько ждать, пока смонтированное приложение отрисует топбар */
const ANCHOR_WAIT_MS = 1500;
/** Во сколько раз ускоряется вход, если пользователь кликнул или нажал клавишу */
const SKIP_SPEED = 4;
/** Дольше ждать шрифт незачем: он локальный, а без него съедет замер ширины слова */
const FONT_WAIT_MS = 400;

/** launch — запуск приложения; resume — обновление поверх открытого приложения */
type IntroMode = "launch" | "resume";
type Scene = "hold" | "activation";
type SceneTarget = Scene | "leave";

interface PendingScene {
  build: (card: HTMLElement | null) => gsap.core.Timeline;
  resolve: () => void;
}

function sceneFor(phase: BootPhase): SceneTarget {
  if (phase === "ready") return "leave";
  return phase === "activation" ? "activation" : "hold";
}

function waitForWordFont() {
  const loaded = document.fonts
    ? document.fonts.load('600 64px "Inter Variable"').then(
        () => undefined,
        () => undefined,
      )
    : Promise.resolve();
  const cap = new Promise<void>((resolve) => window.setTimeout(resolve, FONT_WAIT_MS));
  return Promise.race([loaded, cap]);
}

/**
 * Проверки запуска закончились (лицензия и обновления решены) — лента
 * заставки может тормозить. true, если уже; иначе промис.
 */
function checksDone(): true | Promise<void> {
  if (useBoot.getState().phase !== "checking") return true;
  return new Promise((resolve) => {
    const unsubscribe = useBoot.subscribe((state) => {
      if (state.phase === "checking") return;
      unsubscribe();
      resolve();
    });
  });
}

/** Первый запуск после установки или обновления — «Проявка», иначе «Вырезка» */
function buildLaunch(parts: IntroParts) {
  return useBoot.getState().freshVersion ? buildDevelop(parts, checksDone) : buildEntrance(parts, checksDone);
}

function revealAnchors() {
  document.documentElement.removeAttribute(INTRO_ATTR);
}

/**
 * Заставка запуска: знак собирается в центре, пока снизу идут проверки
 * лицензии и обновлений. Дальше — по фазе: перелёт в топбар, подъём к
 * табличке активации или загрузка обновления. Клик или клавиша ускоряют вход.
 */
export function IntroSplash() {
  const phase = useBoot((s) => s.phase);
  const [shown, setShown] = useState(true);
  const [run, setRun] = useState<{ id: number; mode: IntroMode }>({ id: 0, mode: "launch" });

  // Обновление из открытого приложения снова поднимает заставку. Каждый
  // показ — новый экземпляр: скрытие и показ могут попасть в один рендер,
  // и без ключа React оставил бы сцену, которая уже доиграла уход.
  if (phase !== "ready" && !shown) {
    setShown(true);
    setRun((previous) => ({ id: previous.id + 1, mode: "resume" }));
  }

  useEffect(() => {
    useBoot.getState().start();
  }, []);

  const handleDone = useCallback(() => {
    setShown(false);
    useBoot.getState().markSettled();
  }, []);

  return shown ? <IntroStage key={run.id} mode={run.mode} onDone={handleDone} /> : null;
}

function IntroStage({ mode, onDone }: { mode: IntroMode; onDone: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const asciiRef = useRef<HTMLCanvasElement>(null);
  const phase = useBoot((s) => s.phase);
  const [entered, setEntered] = useState(false);
  const [scene, setScene] = useState<Scene>("hold");

  const partsRef = useRef<IntroParts | null>(null);
  const sceneRef = useRef<SceneTarget>("hold");
  const idleRef = useRef<gsap.core.Tween | null>(null);
  const runningRef = useRef(false);
  const pendingRef = useRef<PendingScene | null>(null);
  const exitSafetyRef = useRef<number | undefined>(undefined);
  const skipRef = useRef<() => void>(() => undefined);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // Страховка ухода не должна пережить сцену и закрыть следующий показ.
  useEffect(() => () => window.clearTimeout(exitSafetyRef.current), []);

  const { contextSafe } = useGSAP(
    (_context, contextSafe) => {
      const root = rootRef.current;
      if (!root || !contextSafe) return;

      const html = document.documentElement;
      html.setAttribute(INTRO_ATTR, "");

      let entrance: gsap.core.Timeline | null = null;
      let cancelled = false;
      let done = false;
      // ASCII-фон живёт только пока открыта заставка
      const ascii = asciiRef.current ? createAsciiBackdrop(asciiRef.current) : null;
      ascii?.start();

      const markEntered = () => {
        if (done) return;
        done = true;
        entrance?.timeScale(1);
        setEntered(true);
      };

      const start = contextSafe(() => {
        if (cancelled) return;
        try {
          const parts = collectParts(root);
          parts.ascii = ascii ?? undefined;
          partsRef.current = parts;
          entrance =
            mode === "resume"
              ? buildReentry(parts, findAnchors()).add(markEntered)
              : buildLaunch(parts).add(markEntered, EXIT_LABEL);
        } catch (error) {
          // Анимация — не повод запереть запуск: показываем всё без неё,
          // а ошибку отдаём глобальному репортёру.
          reportError(error);
          root.dataset.fallback = "";
          markEntered();
        }
      });

      const skip = () => {
        if (entrance && !done) entrance.timeScale(SKIP_SPEED);
      };
      skipRef.current = skip;

      root.addEventListener("pointerdown", skip);
      window.addEventListener("keydown", skip);
      // Страховка считает время только после проверок: пока они идут, лента
      // заставки едет сколько нужно, и это не зависание.
      let safety: number | undefined;
      const armSafety = () => {
        if (cancelled) return;
        safety = window.setTimeout(() => {
          if (done) return;
          entrance?.progress(1);
          markEntered();
        }, SAFETY_MS);
      };
      const ready = checksDone();
      if (ready === true) armSafety();
      else void ready.then(armSafety);

      if (mode === "resume") start();
      else void waitForWordFont().then(start);

      return () => {
        cancelled = true;
        ascii?.stop();
        root.removeEventListener("pointerdown", skip);
        window.removeEventListener("keydown", skip);
        window.clearTimeout(safety);
        revealAnchors();
      };
    },
    { scope: rootRef },
  );

  /** Переключает сцену и ждёт, пока React её отрисует и таймлайн доиграет */
  const renderScene = (next: Scene, build: PendingScene["build"]) =>
    new Promise<void>((resolve) => {
      pendingRef.current = { build, resolve };
      setScene(next);
    });

  // Таймлайн сцены строится после отрисовки: Flip мерит уже новую раскладку.
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    try {
      void contextSafe(() => pending.build(cardRef.current))().then(pending.resolve);
    } catch (error) {
      reportError(error);
      pending.resolve();
    }
  }, [scene, contextSafe]);

  const startIdle = () => {
    const parts = partsRef.current;
    if (!parts || idleRef.current) return;
    idleRef.current = contextSafe(() => buildIdle(parts))();
  };

  const stopIdle = () => {
    idleRef.current?.kill();
    idleRef.current = null;
  };

  const leave = async (parts: IntroParts, root: HTMLElement, card: HTMLElement | null) => {
    sceneRef.current = "leave";
    root.dataset.state = "leaving";
    const finish = () => {
      window.clearTimeout(exitSafetyRef.current);
      onDoneRef.current();
    };
    exitSafetyRef.current = window.setTimeout(finish, EXIT_SAFETY_MS);
    const anchors = await waitForAnchors(ANCHOR_WAIT_MS);
    try {
      await contextSafe(() => buildExit(parts, anchors, card, revealAnchors))();
    } catch (error) {
      reportError(error);
    }
    finish();
  };

  const rise = async (parts: IntroParts) => {
    // Снимок до перерисовки: после неё локап уже меньше и выше.
    const before = Flip.getState(parts.lockup);
    sceneRef.current = "activation";
    await renderScene("activation", (card) =>
      card ? buildRise(parts, before, card) : gsap.timeline(),
    );
    cardRef.current?.querySelector("input")?.focus({ preventScroll: true });
  };

  const descend = async (parts: IntroParts) => {
    await contextSafe(() => buildCardOut(parts, cardRef.current))();
    sceneRef.current = "hold";
    await renderScene("hold", () => buildSettle(parts));
  };

  /**
   * Ведёт заставку к сцене текущей фазы. Переходы идут строго по одному:
   * фаза, сменившаяся посреди перехода, подхватывается после него.
   */
  const advance = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      for (;;) {
        const parts = partsRef.current;
        const root = rootRef.current;
        const current = sceneRef.current;
        const target = sceneFor(useBoot.getState().phase);
        if (!root || current === "leave" || current === target) break;
        stopIdle();
        if (!parts) {
          // Без таймлайна (запасной режим) сцены просто переключаются.
          sceneRef.current = target;
          if (target === "leave") onDoneRef.current();
          else setScene(target);
          break;
        }
        if (target === "leave") {
          await leave(parts, root, current === "activation" ? cardRef.current : null);
        } else if (target === "activation") {
          await rise(parts);
        } else {
          await descend(parts);
        }
      }
      if (sceneRef.current === "hold") startIdle();
    } finally {
      runningRef.current = false;
    }
  };

  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  useEffect(() => {
    if (entered) void advanceRef.current();
  }, [entered, phase]);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-state="playing"
      data-scene={scene}
      data-mode={mode}
    >
      <div className={styles.backdrop} data-intro-part="backdrop">
        <canvas ref={asciiRef} className={styles.ascii} aria-hidden="true" />
      </div>
      <BootTitleBar />

      <div className={styles.stage}>
        <div className={styles.lockup} data-intro-part="lockup" aria-hidden="true">
          <div className={styles.markWrap} data-intro-part="markWrap">
            <div className={styles.glow} data-intro-part="glow" />
            <IntroMark className={styles.mark} data-intro-part="mark" />
          </div>
          {/* Слово рисует сцена знака; здесь только место под него в раскладке локапа */}
          <div className={styles.wordWrap} data-intro-part="wordWrap">
            <span className={styles.word} data-intro-part="word">
              <BrandWordmark className={styles.wordmark} />
            </span>
          </div>
        </div>
        {scene === "activation" && <ActivationPanel ref={cardRef} />}
      </div>

      <BootStatus />
    </div>
  );
}

/** Декораций у окна нет: пока топбара нет, двигать и закрывать окно можно отсюда */
function BootTitleBar() {
  const { t } = useTranslation();
  const isMac = useMemo(
    () => typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent || ""),
    [],
  );

  return (
    <div className={cn("drag-region", styles.titleBar)} data-intro-part="titleBar">
      {!isMac && (
        <div className={cn("no-drag", styles.windowControls)}>
          <button
            className={styles.windowButton}
            type="button"
            aria-label={t("boot.window.minimize")}
            onClick={() => void getCurrentWindow().minimize()}
          >
            <RedesignIcon name="minimize" className="size-4" />
          </button>
          <button
            className={cn(styles.windowButton, styles.closeButton)}
            type="button"
            aria-label={t("boot.window.close")}
            onClick={() => void getCurrentWindow().close()}
          >
            <RedesignIcon name="close" className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
