import { caption, counter, cue, EASE, gsap, onFrame, swapText, typeText, type Scope, type Timeline } from "../lib/motion";
import { clamp, noise1d } from "../lib/procedural";
import { QUEUE_ROWS, type QueueRow } from "../views/QueueView";
import { cameraTo, clickCursor, cursorAt, focusPose, moveCursor } from "./camera";
import { b } from "./schedule";

/** Сцена очереди начинается с появления окна */
const T = b(36);
const NEW_URL = "https://www.twitch.tv/leva2k";

/** Прогресс строки в момент времени фичи tau (секунды от её начала) */
function progressAt(row: QueueRow, tau: number) {
  if (row.state === "done") return 100;
  if (row.doneAt == null) return row.p0;
  const start = row.startAt ?? 0;
  const from = row.startAt != null ? 0 : row.p0;
  if (tau < start) return from;
  const rate = (100 - from) / (row.doneAt - start);
  return clamp(from + rate * (tau - start), 0, 100);
}

const mb = (value: number) => `${value.toFixed(1)} MB/s`;
const gib = (value: number) => `${value.toFixed(2)} GiB`;
const clock = (seconds: number) => {
  const whole = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
};

/** Живая очередь: скорость дышит, ETA тает, размер растёт — всё от времени */
function simulateRows($: Scope) {
  const rows = QUEUE_ROWS.map((row, index) => ({
    row,
    wobble: noise1d(100 + index * 17, 64),
    fill: $.one(`q.row.${row.id}.fill`),
    done: $.one(`q.row.${row.id}.done`),
    pct: $.one(`q.row.${row.id}.pct`),
    speed: $.one(`q.row.${row.id}.speed`),
    eta: $.one(`q.row.${row.id}.eta`),
    size: $.one(`q.row.${row.id}.size`),
  }));
  const footerSpeed = $.one("q.footer.speed");
  const status = $.one("win.status.count");

  onFrame((time) => {
    const tau = time - T;
    let total = 0;
    let active = 0;
    for (const item of rows) {
      const p = progressAt(item.row, tau);
      const started = item.row.startAt == null || tau >= item.row.startAt;
      const downloading = item.row.state !== "done" && started && p < 100 && item.row.doneAt != null;
      item.fill.style.transform = `scaleX(${p / 100})`;
      item.done.style.transform = `scaleX(${p / 100})`;
      item.pct.textContent = `${Math.floor(p)}%`;
      item.size.textContent = p > 0 ? gib((item.row.sizeGiB * p) / 100) : "—";
      if (downloading) {
        const speed = item.row.speed * (0.9 + 0.2 * item.wobble(time * 1.7));
        const left = (item.row.sizeGiB * (100 - p)) / 100;
        item.speed.textContent = mb(speed);
        item.eta.textContent = clock((left * 1024) / speed);
        total += speed;
        active += 1;
      } else {
        item.speed.textContent = "—";
        item.eta.textContent = "—";
      }
    }
    footerSpeed.textContent = `${Math.round(total)} MB/s`;
    status.textContent = active > 0 ? `${total.toFixed(0)} MB/s ·${active}` : "0 MB/s";
  });
}

export function buildQueue(tl: Timeline, $: Scope) {
  simulateRows($);

  const win = $.one("win");
  const cursor = $.one("cursor");
  const layer = $.one("at");
  const dialog = $.one("at.dialog");
  const newRow = $.one("q.row.new");
  const others = QUEUE_ROWS.map((row) => $.one(`q.row.${row.id}`));

  // Новая строка пока не существует: остальные стоят на слот выше
  gsap.set(others, { y: -76 });
  gsap.set(newRow, { autoAlpha: 0 });
  gsap.set($.one("at.url.caret"), { opacity: 0 });

  const add = cursorAt($, $.one("q.add"));
  const url = cursorAt($, $.one("at.url"), -180);
  const blur = cursorAt($, $.one("at.opt.blur"), -150);
  const mute = cursorAt($, $.one("at.opt.mute"), -150);
  const submit = cursorAt($, $.one("at.submit"));

  caption(tl, $, "queue", b(37.4), b(41.2));

  // ── Открыть модалку ──
  tl.fromTo(cursor, { x: win.offsetWidth * 0.62, y: 470, opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power1.out" }, b(37.6));
  moveCursor(tl, $, b(37.8), add, 0.6);
  clickCursor(tl, $, b(39));
  cue("modalOpen", b(39) + 0.06);
  tl.set(layer, { visibility: "visible" }, b(39) + 0.06)
    .fromTo($.one("at.overlay"), { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power1.out" }, b(39) + 0.06)
    .fromTo(dialog, { opacity: 0, scale: 0.96, y: 14 }, { opacity: 1, scale: 1, y: 0, duration: 0.4, ease: "back.out(1.3)" }, b(39) + 0.06);
  cameraTo(tl, $, b(39), { x: 300, y: 20, scale: 0.95, rotationY: -4, rotationX: 2 }, 1.0);

  // ── Ссылка ──
  moveCursor(tl, $, b(39.6), url, 0.45);
  clickCursor(tl, $, b(40.4));
  tl.to($.one("at.url.placeholder"), { opacity: 0, duration: 0.12 }, b(40.4) + 0.06).set($.one("at.url"), { borderColor: "rgba(61,125,255,0.7)" }, b(40.4));
  tl.add(typeText($.one("at.url.text"), NEW_URL, { duration: 0.6 }), b(40.6));
  cue("type", b(40.6), { dur: 0.6, n: NEW_URL.length });
  const caret = $.one("at.url.caret");
  onFrame((time) => {
    const focused = time > b(40.4) && time < b(43);
    caret.style.opacity = focused && (time < b(41.8) || Math.floor(time * 2.4) % 2 === 0) ? "1" : "0";
  });

  // ── Превью подтянулось: крупно кадр стрима ──
  cue("preview", b(42));
  tl.to($.one("at.player.empty"), { opacity: 0, duration: 0.3 }, b(42))
    .fromTo($.one("at.player.frame"), { opacity: 0, scale: 1.06 }, { opacity: 1, scale: 1, duration: 0.7, ease: EASE.out }, b(42))
    .to($.one("at.info"), { opacity: 1, duration: 0.4 }, b(42.2));
  cameraTo(tl, $, b(41.7), focusPose($, $.one("at.player"), 1.55, { rotationY: -5, rotationX: 3 }, { x: 1010, y: 520 }), 1.1, "power3.inOut");

  // ── Опции: блюр и мат одним кликом ──
  cameraTo(tl, $, b(43.6), focusPose($, $.one("at.opt.blur"), 1.25, { rotationY: 4 }, { x: 900, y: 560 }), 0.9);
  moveCursor(tl, $, b(43.6), blur, 0.5);
  clickCursor(tl, $, b(44.4));
  cue("check", b(44.4) + 0.03);
  tl.fromTo($.one("at.opt.blur.fill"), { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)" }, b(44.4) + 0.03);
  moveCursor(tl, $, b(44.6), mute, 0.28);
  clickCursor(tl, $, b(45.2));
  cue("check", b(45.2) + 0.03);
  tl.fromTo($.one("at.opt.mute.fill"), { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)" }, b(45.2) + 0.03);

  // ── В очередь ──
  moveCursor(tl, $, b(45.4), submit, 0.35);
  clickCursor(tl, $, b(46));
  cue("modalClose", b(46) + 0.08);
  cue("insert", b(46.6));
  tl.to(dialog, { opacity: 0, scale: 0.97, y: 8, duration: 0.24, ease: "power2.in" }, b(46) + 0.08)
    .to($.one("at.overlay"), { opacity: 0, duration: 0.24, ease: "power1.in" }, b(46) + 0.1)
    .set(layer, { visibility: "hidden" }, b(46) + 0.4);
  // Общий план с наклоном: окно слева, подпись справа
  cameraTo(tl, $, b(46), { x: -300, y: 30, scale: 0.8, rotationY: 9, rotationX: 4, rotation: -1.5 }, 1.2, "expo.inOut");
  tl.to(cursor, { opacity: 0, duration: 0.3 }, b(46.4));
  caption(tl, $, "threads", b(46.8), b(50.2));

  // Строка въезжает сверху, остальные сдвигаются на слот
  tl.to(others, { y: 0, duration: 0.55, ease: EASE.cine, stagger: 0.025 }, b(46.5))
    .fromTo(newRow, { autoAlpha: 0, x: -30 }, { autoAlpha: 1, x: 0, duration: 0.6, ease: EASE.out, immediateRender: false }, b(46.6))
    .fromTo($.one("q.row.new.flash"), { opacity: 0 }, { opacity: 1, duration: 0.2, ease: "none", immediateRender: false }, b(46.6))
    .to($.one("q.row.new.flash"), { opacity: 0, duration: 1.1, ease: "power2.out" }, b(47));
  tl.add(counter($.one("q.footer.count"), 4, 5, (v) => `${Math.round(v)} задач`, { duration: 0.01 }), b(46.6));
  tl.add(counter($.one("nav.queue.badge"), 4, 5, (v) => `${Math.round(v)}`, { duration: 0.01 }), b(46.6));

  // ── Крупно: цифры скорости и ETA бегут, камера проезжает по колонкам ──
  const rows = $.one("q.rows");
  cameraTo(tl, $, b(50.4), focusPose($, rows, 1.7, { rotationY: -6, rotationX: 6, rotation: 1 }, { x: 1320, y: 560 }), 1.0, "power3.inOut");
  tl.to($.one("rig"), { x: "+=820", duration: BEAT_PAN, ease: "sine.inOut" }, b(52.2));

  // GEO докачался на сильную долю — статус меняется, полоса зеленеет
  const geoDone = b(54);
  cue("success", geoDone);
  cue("start", b(54.5));
  swapText(tl, $.one("q.row.geo.st.running"), $.one("q.row.geo.st.done"), geoDone);
  tl.to($.one("q.row.geo.done"), { opacity: 1, duration: 0.35, ease: "power1.out" }, geoDone);
  tl.add(counter($.one("nav.queue.badge"), 5, 4, (v) => `${Math.round(v)}`, { duration: 0.01 }), geoDone);
  // Освободился поток — стартует ожидавший m3u8
  swapText(tl, $.one("q.row.hls.st.queued"), $.one("q.row.hls.st.running"), b(54.5));
  cameraTo(tl, $, b(53.6), { x: 0, y: 30, scale: 0.86, rotationY: 0, rotationX: 4 }, 1.0, "expo.inOut");
}

/** Проезд камеры по колонкам таблицы — ровно два такта */
const BEAT_PAN = b(53.5) - b(52.2);
