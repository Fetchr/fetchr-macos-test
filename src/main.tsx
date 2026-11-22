import React from "react";
import ReactDOM from "react-dom/client";

import "@/styles/globals.css";
import { i18nReady } from "@/i18n";

import { App } from "@/App";
import { installErrorReporting } from "@/lib/errorReporting";
import { installIconMotion } from "@/ui/redesign/icons/motion/runtime";
import { applyPlatformAttribute } from "@/lib/platform";
import "@/ui/redesign/mac/macPlatform.css";

applyPlatformAttribute();
installErrorReporting();
installIconMotion();

const mount = () => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
};

// Русский словарь уже в основном бандле; ждём чанк только если выбран английский.
if (localStorage.getItem("fetchr-locale") === "en") {
  void i18nReady.then(mount);
} else {
  mount();
}
