import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { formatShortcuts, IS_MACOS } from "@/lib/platform";

import ru from "./ru.json";

const storedLocale = localStorage.getItem("fetchr-locale");
const initialLocale = storedLocale === "en" ? "en" : "ru";

let enLoaded = false;

export async function ensureLocale(lng: string): Promise<void> {
  if (lng !== "en" || enLoaded) return;
  const mod = await import("./en.json");
  i18n.addResourceBundle("en", "translation", mod.default, true, true);
  enLoaded = true;
}

void i18n
  .use(initReactI18next)
  .use({
    type: "postProcessor",
    name: "platformShortcuts",
    process: (value: string) => formatShortcuts(value),
  })
  .init({
    resources: {
      ru: { translation: ru },
    },
    lng: initialLocale,
    fallbackLng: "ru",
    interpolation: { escapeValue: false },
    // На macOS «Ctrl+N» в текстах превращается в «⌘N».
    postProcess: IS_MACOS ? ["platformShortcuts"] : false,
  });

export const i18nReady: Promise<void> =
  initialLocale === "en"
    ? ensureLocale("en").then(() => {
        void i18n.changeLanguage("en");
      })
    : Promise.resolve();

export default i18n;
