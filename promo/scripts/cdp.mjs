/**
 * Минимальный клиент Chrome DevTools Protocol поверх headless Edge.
 *
 * Без puppeteer/playwright: Node 22 умеет WebSocket из коробки, а Edge стоит
 * в любой Windows. Скрипт поднимает свой экземпляр браузера с отдельным
 * профилем и убирает его при закрытии.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_BROWSER = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = targets.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      // браузер ещё поднимается
    }
    await sleep(150);
  }
  throw new Error(`DevTools endpoint on port ${port} did not come up in ${timeoutMs} ms`);
}

export async function launchBrowser({ port = 9333, width = 1920, height = 1080, scale = 1 } = {}) {
  const browser = process.env.PROMO_BROWSER ?? DEFAULT_BROWSER;
  const profile = mkdtempSync(path.join(tmpdir(), "fetchr-promo-"));
  const proc = spawn(
    browser,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      // Без этого цвета пройдут через профиль монитора и уплывут от токенов.
      "--force-color-profile=srgb",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const page = await waitForEndpoint(port, 60000);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    for (const handler of listeners.get(message.method) ?? []) handler(message.params);
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const on = (method, handler) => {
    const list = listeners.get(method) ?? [];
    listeners.set(method, [...list, handler]);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false,
  });

  /** Выполняет выражение в странице и возвращает значение (await-ит промисы) */
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      const text = exceptionDetails.exception?.description ?? exceptionDetails.text;
      throw new Error(`Page threw: ${text}`);
    }
    return result.value;
  };

  const navigate = async (url, timeoutMs = 90000) => {
    const loaded = new Promise((resolve) => on("Page.loadEventFired", resolve));
    await send("Page.navigate", { url });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Page load timed out: ${url}`)), timeoutMs);
    });
    try {
      await Promise.race([loaded, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  const screenshot = async (options = {}) => {
    const { data } = await send("Page.captureScreenshot", { format: "png", ...options });
    return Buffer.from(data, "base64");
  };

  const close = async () => {
    try {
      await send("Browser.close");
    } catch {
      proc.kill();
    }
    ws.close();
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // Edge иногда держит файлы профиля ещё мгновение — не критично
    }
  };

  return { send, on, evaluate, navigate, screenshot, close };
}

export async function waitFor(evaluate, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}
