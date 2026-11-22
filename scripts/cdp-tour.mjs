/* CDP-обход экранов Fetchr: клавиатурные шорткаты + скриншоты каждой страницы. */
import { writeFileSync, mkdirSync } from "node:fs";

const CDP = "http://127.0.0.1:9222";
const OUT = "_shots";
mkdirSync(OUT, { recursive: true });

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("127.0.0.1:1420"));
if (!page) { console.error("page not found"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
await send("Page.enable");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function key(k, code, vk, modifiers = 0) {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
}

async function shot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, "base64"));
  console.log("shot", name);
}

const VK = { q: 81, l: 76, f: 70, c: 67, p: 80, v: 86, r: 82, i: 73, s: 83, w: 87, n: 78, k: 75 };
const tour = [
  ["02-queue", "q"],
  ["03-logs", "l"],
  ["04-finder", "f"],
  ["05-chat-render", "c"],
  ["06-sponsor-blur", "p"],
  ["07-fetchr-mute", "v"],
  ["08-vocal-remover", "r"],
  ["09-live-recorder", "i"],
  ["10-settings", "s"],
  ["11-presets", "w"],
];

await sleep(600);
for (const [name, letter] of tour) {
  await key("g", "KeyG", 71);
  await sleep(220);
  await key(letter, `Key${letter.toUpperCase()}`, VK[letter]);
  await sleep(1100);
  await shot(name);
}

// Модалка добавления задачи (Ctrl+N), закрыть по Esc
await key("g", "KeyG", 71); await sleep(220); await key("q", "KeyQ", VK.q); await sleep(800);
await key("n", "KeyN", VK.n, 2);
await sleep(900);
await shot("12-addtask-modal");
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

// Командная палитра (Ctrl+K)
await sleep(500);
await key("k", "KeyK", VK.k, 2);
await sleep(700);
await shot("13-command-palette");
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

console.log("done");
ws.close();
process.exit(0);
