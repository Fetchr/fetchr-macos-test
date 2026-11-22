import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ipc } from "@/lib/ipc";
import { IS_MACOS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useSettings, type UiMode } from "@/stores/settings";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";
import { NavPositionPicker } from "@/ui/redesign/settings/NavPositionPicker";
import { UiModePicker } from "@/ui/redesign/settings/UiModePicker";
import { createAsciiBackdrop } from "@/ui/redesign/intro/asciiBackdrop";
import { EASE, gsap } from "@/ui/redesign/theme/gsapSetup";

import styles from "./FirstRunSetup.module.css";
import { SetupInstallStep } from "./SetupInstallStep";
import { componentsFor, SETUP_TOOLS } from "./setupTools";

type StepId = "welcome" | "tools" | "folder" | "mode" | "layout" | "install" | "done";

const ALL_STEPS: Array<{ id: StepId; icon: RedesignIconName }> = [
  { id: "welcome", icon: "sparkle" },
  { id: "tools", icon: "preset" },
  { id: "folder", icon: "folder" },
  { id: "mode", icon: "sparkle" },
  { id: "layout", icon: "home" },
  { id: "install", icon: "install" },
  { id: "done", icon: "check" },
];

/**
 * На Mac интерфейс только MacOS: ни режим, ни положение панели не выбираются.
 * В режиме MacOS разделы всегда в боковой панели, шаг «layout» не нужен.
 */
function stepsFor(uiMode: UiMode) {
  return ALL_STEPS.filter((item) => {
    if (item.id === "mode") return !IS_MACOS;
    if (item.id === "layout") return !IS_MACOS && uiMode === "simple";
    return true;
  });
}

/**
 * Первоначальная настройка в духе приветствия Windows: язык, набор
 * инструментов, папка для файлов, установка нужного ПО и финал.
 * Выбор инструментов прячет лишние вкладки, а для выбранных сразу
 * докачивает зависимости, чтобы первая задача не ждала загрузки моделей.
 */
export function FirstRunSetup() {
  const { t, i18n } = useTranslation();
  const settings = useSettings();
  const [stepIndex, setStepIndex] = useState(0);
  const [selected, setSelected] = useState<string[]>(
    () => settings.enabledTools ?? SETUP_TOOLS.map((tool) => tool.id),
  );
  const [hovered, setHovered] = useState<string | null>(null);
  const [installSettled, setInstallSettled] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLDivElement>(null);
  const asciiRef = useRef<HTMLCanvasElement>(null);
  const directionRef = useRef(1);

  const steps = useMemo(() => stepsFor(settings.uiMode), [settings.uiMode]);
  const step = steps[stepIndex];
  const components = useMemo(() => componentsFor(selected), [selected]);

  // Окно проявляется, как экран приветствия Windows: фон, затем рамка.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const tl = gsap
      .timeline()
      .fromTo(root, { opacity: 0 }, { opacity: 1, duration: 0.45, ease: "power2.out" })
      .fromTo(
        root.querySelector("[data-setup-frame]"),
        { opacity: 0, y: 24, scale: 0.98 },
        { opacity: 1, y: 0, scale: 1, duration: 0.7, ease: EASE.cine },
        0.1,
      );
    return () => {
      tl.kill();
    };
  }, []);

  // Тот же ASCII-фон, что у заставки, но спокойный: без перемотки и волны
  useEffect(() => {
    const canvas = asciiRef.current;
    if (!canvas) return;
    const ascii = createAsciiBackdrop(canvas, { intensity: 0.42, glow: 0.22 });
    ascii.state.calm = 1;
    ascii.start();
    const fade = gsap.to(ascii.state, { fade: 1, duration: 1.4, ease: "sine.inOut" });
    // Поле медленно течёт, как будто лента ещё едет где-то далеко
    const drift = gsap.to(ascii.state, { scroll: "+=4000", duration: 120, ease: "none", repeat: -1 });
    return () => {
      fade.kill();
      drift.kill();
      ascii.stop();
    };
  }, []);

  // Смена шага: содержимое уезжает в сторону движения, заголовок слева проявляется.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const aside = asideRef.current;
    if (!stage || !aside) return;
    const tl = gsap
      .timeline()
      .fromTo(
        stage,
        { opacity: 0, x: 28 * directionRef.current },
        { opacity: 1, x: 0, duration: 0.5, ease: EASE.cine, clearProps: "transform" },
      )
      .fromTo(
        aside.children,
        { opacity: 0, y: 10 },
        { opacity: 1, y: 0, duration: 0.45, ease: EASE.out, stagger: 0.06 },
        0,
      );
    return () => {
      tl.kill();
    };
  }, [stepIndex]);

  const go = (delta: number) => {
    directionRef.current = delta;
    setStepIndex((index) => Math.min(steps.length - 1, Math.max(0, index + delta)));
  };

  const next = () => {
    if (step.id === "tools") {
      const all = selected.length === SETUP_TOOLS.length;
      settings.setEnabledTools(all ? null : selected);
    }
    if (step.id === "install") setInstallSettled(false);
    go(1);
  };

  const finish = () => settings.setSetupCompleted(true);

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  const chooseFolder = async () => {
    const dir = await ipc.chooseDirectory().catch(() => null);
    if (dir) settings.setDirectory(dir);
  };

  const onInstallSettled = useCallback((settled: boolean) => setInstallSettled(settled), []);

  const nextDisabled = step.id === "install" && !installSettled;
  const hint = hovered ? t(`setup.tools.${hovered.replaceAll("-", "_")}`) : t("setup.tools_hint");

  return (
    <div ref={rootRef} className={styles.root} role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <canvas ref={asciiRef} className={styles.ascii} aria-hidden="true" />
      <div className={cn("drag-region", styles.dragBar)} />
      <div className={styles.frame} data-setup-frame>
        <aside ref={asideRef} className={styles.aside}>
          <span className={styles.asideIcon} aria-hidden>
            <RedesignIcon name={step.icon} className="size-7" strokeWidth={1.6} />
          </span>
          <h1 id="setup-title" className={styles.title}>
            {t(`setup.steps.${step.id}.title`)}
          </h1>
          <p className={styles.subtitle}>{t(`setup.steps.${step.id}.subtitle`)}</p>
        </aside>

        <section className={styles.main}>
          <div ref={stageRef} className={styles.stage}>
            {step.id === "welcome" && (
              <div className={styles.welcome}>
                <p className={styles.lead}>{t("setup.welcome.lead")}</p>
                <div className={styles.fieldLabel}>{t("setup.welcome.language")}</div>
                <div className={styles.choiceList} role="radiogroup">
                  {(["ru", "en"] as const).map((locale) => (
                    <button
                      key={locale}
                      type="button"
                      role="radio"
                      aria-checked={settings.locale === locale}
                      className={styles.choice}
                      data-active={settings.locale === locale || undefined}
                      onClick={() => {
                        settings.setLocale(locale);
                        void i18n.changeLanguage(locale);
                      }}
                    >
                      <span className={styles.choiceMark} aria-hidden />
                      {locale === "ru" ? "Русский" : "English"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {step.id === "tools" && (
              <div className={styles.toolsGrid} onMouseLeave={() => setHovered(null)}>
                {SETUP_TOOLS.map((tool) => {
                  const on = tool.locked || selected.includes(tool.id);
                  return (
                    <button
                      key={tool.id}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-disabled={tool.locked || undefined}
                      aria-describedby="setup-hint"
                      className={styles.tool}
                      data-active={on || undefined}
                      onClick={() => !tool.locked && toggle(tool.id)}
                      onMouseEnter={() => setHovered(tool.id)}
                      onFocus={() => setHovered(tool.id)}
                    >
                      <span className={styles.toolIcon} aria-hidden>
                        <RedesignIcon name={tool.icon} className="size-5" />
                      </span>
                      <span className={styles.toolName}>{t(`nav.${tool.id.replaceAll("-", "_")}`)}</span>
                      <span className={styles.toolCheck} aria-hidden>
                        {on && <RedesignIcon name="check" className="size-3.5" strokeWidth={2.4} />}
                      </span>
                      {tool.locked && <span className={styles.toolLock}>{t("setup.always_on")}</span>}
                    </button>
                  );
                })}
              </div>
            )}

            {step.id === "folder" && (
              <div className={styles.welcome}>
                <p className={styles.lead}>{t("setup.folder.lead")}</p>
                <div className={styles.folderRow}>
                  <span className={styles.folderPath} title={settings.directory}>
                    {settings.directory || t("setup.folder.default")}
                  </span>
                  <button className={styles.secondary} type="button" onClick={() => void chooseFolder()}>
                    <RedesignIcon name="folder" className="size-4" />
                    {t("setup.folder.choose")}
                  </button>
                </div>
              </div>
            )}

            {step.id === "mode" && (
              <div className={styles.welcome}>
                <UiModePicker />
              </div>
            )}

            {step.id === "layout" && (
              <div className={styles.welcome}>
                <NavPositionPicker />
              </div>
            )}

            {step.id === "install" && (
              <SetupInstallStep components={components} onSettled={onInstallSettled} />
            )}

            {step.id === "done" && (
              <div className={styles.welcome}>
                <p className={styles.lead}>{t("setup.done.lead")}</p>
                <ul className={styles.summary}>
                  {SETUP_TOOLS.filter((tool) => tool.locked || selected.includes(tool.id)).map((tool) => (
                    <li key={tool.id}>
                      <RedesignIcon name={tool.icon} className="size-4" />
                      {t(`nav.${tool.id.replaceAll("-", "_")}`)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {step.id === "tools" && (
            <p id="setup-hint" className={styles.hint} data-active={hovered ? true : undefined} aria-live="polite">
              <RedesignIcon name="info" className="size-4 shrink-0" />
              <span key={hovered ?? "none"} className={styles.hintText}>
                {hint}
              </span>
            </p>
          )}

          <footer className={styles.footer}>
            <div className={styles.dots} aria-hidden>
              {steps.map((item, index) => (
                <span key={item.id} data-state={index === stepIndex ? "current" : index < stepIndex ? "done" : undefined} />
              ))}
            </div>
            <div className={styles.buttons}>
              {stepIndex > 0 && step.id !== "done" && step.id !== "install" && (
                <button className={styles.ghost} type="button" onClick={() => go(-1)}>
                  {t("setup.back")}
                </button>
              )}
              {step.id === "done" ? (
                <button className={styles.primary} type="button" onClick={finish}>
                  {t("setup.start")}
                  <RedesignIcon name="play" className="size-3.5" />
                </button>
              ) : (
                <button className={styles.primary} type="button" onClick={next} disabled={nextDisabled}>
                  {step.id === "welcome" ? t("setup.begin") : t("setup.next")}
                </button>
              )}
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}
