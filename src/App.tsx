import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";
import { Toaster } from "sonner";

import { preloadPages, router } from "@/app/router";
import { PrivacyNotice } from "@/components/privacy-notice";
import { usePressFeedback } from "@/hooks/usePressFeedback";
import { useBoot } from "@/stores/boot";
import { BootGate, IntroSplash } from "@/ui/redesign/intro";
import { initGsapEnvironment } from "@/ui/redesign/theme/gsapSetup";

export function App() {
  // Системная настройка «уменьшить движение». Раньше это делал
  // MotionConfig reducedMotion="user"; CSS-часть по-прежнему закрыта
  // блоком prefers-reduced-motion в globals.css.
  useEffect(() => initGsapEnvironment(), []);
  usePressFeedback();

  // Страницы грузятся отдельными чанками; после заставки прогреваем их в
  // простое, чтобы первый переход был мгновенным и не мешал анимации входа.
  const settled = useBoot((s) => s.settled);
  useEffect(() => {
    if (!settled) return;
    // WKWebView (macOS) не знает requestIdleCallback — там простой таймер.
    if (typeof window.requestIdleCallback !== "function") {
      const timer = window.setTimeout(preloadPages, 1500);
      return () => window.clearTimeout(timer);
    }
    const id = window.requestIdleCallback(preloadPages, { timeout: 3000 });
    return () => window.cancelIdleCallback(id);
  }, [settled]);

  // Заставка стоит снаружи гейта: она сама ведёт проверку лицензии,
  // активацию и обновление, а приложение встаёт под ней, когда пустят.
  return (
    <>
      <BootGate>
        <RouterProvider router={router} />
        <Toaster theme="dark" position="bottom-right" richColors closeButton />
      </BootGate>
      <IntroSplash />
      <PrivacyNotice />
    </>
  );
}
