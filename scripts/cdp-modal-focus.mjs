import { writeFileSync } from "node:fs";

const targets = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
const target = targets.find((t) => t.url.includes(":1420"));
if (!target) throw new Error("no target");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) =>
  new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  return r?.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable");

// 1. Close modal by CDP mouse click on "Отмена" (no real focus change)
const rect = await evalJs(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "Отмена");
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
if (rect) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  }
}
await sleep(400);
const modalGone = await evalJs(`![...document.querySelectorAll("button")].some((x) => (x.textContent || "").trim() === "Добавить в очередь")`);
console.log("modal closed:", modalGone);

// 2. Reopen modal via CDP Ctrl+N (no focus steal)
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Control", code: "ControlLeft", modifiers: 2, windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "n", code: "KeyN", modifiers: 2, windowsVirtualKeyCode: 78, nativeVirtualKeyCode: 78 });
await send("Input.dispatchKeyEvent", { type: "char", key: "n", text: "n", code: "KeyN", modifiers: 2, windowsVirtualKeyCode: 78, nativeVirtualKeyCode: 78 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "n", code: "KeyN", modifiers: 2, windowsVirtualKeyCode: 78, nativeVirtualKeyCode: 78 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
await sleep(600);
const modalOpen = await evalJs(`[...document.querySelectorAll("button")].some((x) => (x.textContent || "").trim() === "Добавить в очередь")`);
console.log("modal reopened:", modalOpen);

// 3. Focus the URL input inside modal, screenshot the input area
if (modalOpen) {
  const ir = await evalJs(`(() => {
    const i = document.querySelector("input");
    if (!i) return null;
    i.focus();
    const r = i.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  await sleep(250);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync("_shots/14-modal-reopened.png", Buffer.from(shot.result.data, "base64"));
  console.log("input rect:", JSON.stringify(ir), "shot saved");
}

ws.close();
process.exit(0);
