import {
  EASE,
  T,
  chain,
  draw,
  growX,
  nudge,
  popIn,
  pulse,
  q,
  rotate,
  slider,
  squash,
  through,
  wave,
} from "./spring";

export interface MotionParts {
  /** named groups declared in `groups` */
  g: Record<string, SVGElement | undefined>;
  /** glyph children in lucide order */
  p: (SVGElement | undefined)[];
  /** wrapper around the whole glyph */
  all: SVGElement | undefined;
}

type ClipRect = [x: number, y: number, width: number, height: number];

export interface Choreography {
  /** group name -> child indices; a group moves as one and can be clipped */
  groups?: Record<string, number[]>;
  /** group name (or "all") -> clip rect in the 24x24 grid, fixed while the group moves through it */
  clips?: Record<string, ClipRect>;
  run: (parts: MotionParts) => void;
}

const D: Record<string, Choreography> = {
  add: { run: ({ all }) => chain(all, "none", [["rotate(-24deg) scale(.82)", q(110)], ["rotate(90deg)", "bouncy"]]) },
  close: { run: ({ all }) => chain(all, "none", [["rotate(-20deg) scale(.82)", q(110)], ["rotate(90deg)", "bouncy"]]) },
  apply: {
    run: ({ p, all }) => {
      draw(p[0], 380);
      chain(all, "none", [["scale(.86)", q(90)], ["none", "bouncy"]], { delay: 300 });
    },
  },
  alert: {
    groups: { ex: [1, 2] },
    clips: { ex: [4, 4, 16, 16] },
    run: ({ g, p }) => {
      squash(p[0], 0.9, 0.9);
      through(g.ex, 0, 9, { delay: 40, s: "bouncy" });
    },
  },
  warning: {
    groups: { ex: [1, 2] },
    clips: { ex: [6, 6.5, 12, 12.5] },
    run: ({ g, p }) => {
      squash(p[0], 1.06, 0.9, { origin: "center bottom" });
      through(g.ex, 0, 9, { delay: 40, s: "bouncy" });
    },
  },
  info: {
    groups: { i: [1, 2] },
    clips: { i: [4, 4, 16, 16] },
    run: ({ g, p }) => {
      squash(p[0], 0.9, 0.9);
      through(g.i, 0, -9, { delay: 40, s: "bouncy" });
    },
  },
  audio: {
    run: ({ p }) => {
      squash(p[0], 0.84, 1, { origin: "right center" });
      nudge(p[1], 1, 0, { delay: 60 });
      nudge(p[2], 1.6, 0, { delay: 130 });
      wave(p[1], 60);
      wave(p[2], 170);
    },
  },
  mute: {
    run: ({ p }) => {
      nudge(p[0], -1.4, 0, { s: "wobbly" });
      draw(p[1], 240, 80);
      draw(p[2], 240, 200);
    },
  },
  vocal: {
    groups: { mic: [4, 5, 6] },
    run: ({ g, p }) => {
      nudge(g.mic, 0, -3);
      [0, 1, 2, 3].forEach((n, i) => squash(p[n], 1, 0.35, { delay: 40 + (i % 2) * 60 }));
    },
  },
  server: {
    run: ({ p }) => {
      nudge([p[0], p[2]], 2.4, 0);
      nudge([p[1], p[3]], -2.4, 0, { delay: 50 });
      wave(p[2], 200, 0.1, 500);
      wave(p[3], 320, 0.1, 500);
    },
  },
  bell: {
    run: ({ all, p }) => {
      chain(all, "none", [["rotate(18deg)", q(90)], ["none", "wobbly"]], { origin: "vb 12 2.5" });
      chain(p[0], "none", [[T(-2.4, 0), q(110)], ["none", "wobbly"]], { delay: 40 });
    },
  },
  bookmark: {
    run: ({ all }) =>
      chain(all, "none", [[T(0, -4), q(150)], ["none", q(130, EASE.in)], ["scale(1.1,.86)", q(70)], ["none", "bouncy"]], {
        origin: "center bottom",
      }),
  },
  blur: {
    run: ({ p }) => {
      squash(p[1], 0.9, 1, { origin: "right center" });
      [2, 3, 4, 5].forEach((n, i) => popIn(p[n], { delay: 60 + i * 70 }));
    },
  },
  chat: {
    run: ({ p }) => {
      chain(p[0], "none", [["scale(.84)", q(110)], ["none", "bouncy"]], { origin: "vb 3 21" });
      growX(p[1], 0.1, "left center", 90);
      growX(p[2], 0.1, "left center", 160);
    },
  },
  arrowDown: { run: ({ all }) => nudge(all, 0, 2.5) },
  arrowUp: { run: ({ all }) => nudge(all, 0, -2.5) },
  chevronDown: { run: ({ all }) => nudge(all, 0, 2.2) },
  chevronUp: { run: ({ all }) => nudge(all, 0, -2.2) },
  chevronLeft: { run: ({ all }) => nudge(all, -2.2, 0) },
  chevronRight: { run: ({ all }) => nudge(all, 2.2, 0) },
  priorityHigh: {
    run: ({ p }) => {
      nudge(p[0], 0, -2);
      nudge(p[1], 0, -2, { delay: 60 });
    },
  },
  priorityLow: {
    run: ({ p }) => {
      nudge(p[1], 0, 2);
      nudge(p[0], 0, 2, { delay: 60 });
    },
  },
  priorityNormal: { run: ({ all }) => chain(all, "none", [["scaleX(.4)", q(130)], ["none", "bouncy"]]) },
  clipboard: {
    run: ({ p }) => {
      chain(p[0], "none", [[T(0, -3), q(130)], ["none", "bouncy"]]);
      squash(p[1], 1.04, 0.92, { delay: 150, origin: "center bottom" });
    },
  },
  copy: {
    run: ({ p }) => {
      nudge(p[0], 2, 2, { in: 140 });
      nudge(p[1], -2, -2, { in: 140 });
    },
  },
  cpu: {
    run: ({ p }) => {
      pulse(p[1], 1.3);
      [8, 2, 7, 6, 3, 9, 4, 5].forEach((n, i) => wave(p[n], i * 45, 0.08, 420));
    },
  },
  download: {
    groups: { ar: [1, 2] },
    clips: { ar: [-2, -6, 28, 22.3] },
    run: ({ g, p }) => {
      through(g.ar, 0, 13, { s: "bouncy" });
      squash(p[0], 1.06, 0.8, { delay: 150, origin: "center bottom" });
    },
  },
  install: {
    groups: { ar: [0, 1] },
    clips: { ar: [-2, -6, 28, 24.3] },
    run: ({ g, p }) => {
      through(g.ar, 0, 15, { s: "bouncy" });
      squash(p[2], 0.7, 1, { delay: 150 });
    },
  },
  expand: {
    groups: { ur: [0, 2], dl: [1, 3] },
    run: ({ g }) => {
      chain(g.ur, "none", [[T(-1.6, 1.6), q(110)], ["none", "bouncy"]]);
      chain(g.dl, "none", [[T(1.6, -1.6), q(110)], ["none", "bouncy"]]);
    },
  },
  exportJson: {
    run: ({ p }) => {
      squash([p[0], p[1]], 0.94, 0.94);
      nudge(p[2], -2.4, 0, { delay: 40 });
      nudge(p[3], 2.4, 0, { delay: 40 });
    },
  },
  external: {
    groups: { ar: [0, 1] },
    clips: { ar: [9, -3, 18, 18] },
    run: ({ g, p }) => {
      through(g.ar, 13, -13, { s: "bouncy" });
      squash(p[2], 0.94, 0.94, { delay: 120 });
    },
  },
  fileAudio: {
    run: ({ p }) => {
      squash([p[0], p[1]], 0.94, 0.94);
      rotate(p[2], -20, { origin: "center bottom", delay: 40 });
    },
  },
  fileVideo: {
    run: ({ p }) => {
      squash([p[0], p[1]], 0.94, 0.94);
      popIn(p[2], { delay: 60 });
    },
  },
  finder: {
    run: ({ all }) =>
      chain(all, "none", [
        ["translate(-2px,-1px) rotate(-12deg)", q(170, EASE.inOut)],
        ["translate(2px,1px) rotate(8deg)", q(230, EASE.inOut)],
        ["none", "bouncy"],
      ]),
  },
  folder: {
    run: ({ all }) =>
      chain(all, "none", [["rotate(-9deg) scale(1.04,.96)", q(130)], ["none", "wobbly"]], { origin: "left bottom" }),
  },
  hidden: {
    run: ({ p }) => {
      squash([p[0], p[1], p[2]], 1, 0.8, { in: 90 });
      draw(p[3], 320, 60);
    },
  },
  visible: {
    run: ({ all, p }) => {
      chain(all, "none", [["scaleY(.08)", q(90, EASE.in)], ["none", "snappy"]]);
      chain(p[1], "none", [[T(2.2, 0), q(180, EASE.inOut)], [T(-1.6, 0), q(260, EASE.inOut)], ["none", "soft"]], {
        delay: 260,
      });
    },
  },
  home: {
    run: ({ p }) => {
      chain(p[0], "none", [["scaleY(0)", q(90, EASE.in)], ["none", "bouncy"]], { origin: "center bottom", delay: 60 });
      squash(p[1], 1.05, 0.92, { origin: "center bottom" });
    },
  },
  image: {
    groups: { m: [2] },
    clips: { all: [3, 3, 18, 18] },
    run: ({ p, g }) => {
      chain(p[1], "none", [[T(0, 10), q(120, EASE.in)], ["none", "bouncy"]]);
      chain(g.m, "none", [[T(-4, 3), q(110, EASE.in)], ["none", "bouncy"]], { delay: 60 });
    },
  },
  key: {
    run: ({ all }) =>
      chain(all, "none", [[T(-1.2, 1.2), q(110)], ["rotate(-50deg)", q(190, EASE.inOut)], ["none", "bouncy"]], {
        origin: "vb 16.5 7.5",
      }),
  },
  link: {
    run: ({ p }) => {
      nudge(p[0], -2.6, 0);
      nudge(p[1], 2.6, 0);
      chain(p[2], "none", [["scaleX(.2)", q(130)], ["none", "bouncy"]]);
    },
  },
  live: {
    run: ({ p }) => {
      pulse(p[2], 1.7, { in: 120 });
      nudge(p[1], -0.8, 0, { delay: 70 });
      nudge(p[3], 0.8, 0, { delay: 70 });
      nudge(p[0], -1.2, 0, { delay: 150 });
      nudge(p[4], 1.2, 0, { delay: 150 });
      wave([p[1], p[3]], 60);
      wave([p[0], p[4]], 160);
    },
  },
  loading: {
    run: ({ all }) => chain(all, "none", [["rotate(-30deg)", q(140, EASE.inOut)], ["rotate(360deg)", "snappy"]]),
  },
  logs: {
    run: ({ p }) => {
      draw(p[1], 280);
      draw(p[0], 280, 140);
      [2, 3, 4].forEach((n, i) => growX(p[n], 0.15, "left center", i * 70));
    },
  },
  media: {
    run: ({ p, all }) => {
      squash(all, 0.92, 0.92);
      growX(p[3], 0.1, "center", 80);
      nudge([p[1], p[2], p[4]], 1.2, 0, { delay: 40 });
      nudge([p[5], p[6], p[7]], -1.2, 0, { delay: 40 });
    },
  },
  more: {
    run: ({ p }) =>
      [2, 0, 1].forEach((n, i) => chain(p[n], "none", [[T(0, -3.4), q(130)], ["none", "bouncy"]], { delay: i * 65 })),
  },
  move: {
    run: ({ p }) => {
      const out = (el: SVGElement | undefined, x: number, y: number) =>
        chain(el, "none", [[T(-x * 0.6, -y * 0.6), q(110)], [T(x, y), q(120)], ["none", "bouncy"]]);
      out(p[5], 0, -2.4);
      out(p[1], 0, 2.4);
      out(p[4], -2.4, 0);
      out(p[2], 2.4, 0);
    },
  },
  pause: {
    run: ({ p }) => {
      chain(p[1], "none", [["scaleY(.5)", q(110)], ["none", "bouncy"]]);
      chain(p[0], "none", [["scaleY(.5)", q(110)], ["none", "bouncy"]], { delay: 70 });
    },
  },
  play: {
    run: ({ all }) =>
      chain(all, "none", [["scale(.84)", q(90)], [T(1.4, 0), q(120)], ["none", "bouncy"]], { origin: "vb 12 12" }),
  },
  pencil: {
    run: ({ all }) =>
      chain(all, "none", [
        ["translate(-1px,1px) rotate(-6deg)", q(110, EASE.inOut)],
        ["translate(1.6px,-1.2px) rotate(4deg)", q(120, EASE.inOut)],
        ["translate(-1px,1px) rotate(-4deg)", q(120, EASE.inOut)],
        ["none", "soft"],
      ], { origin: "vb 3 21" }),
  },
  performance: {
    run: ({ p }) => chain(p[0], "none", [["rotate(-110deg)", q(230, EASE.inOut)], ["none", "wobbly"]], { origin: "vb 12 14" }),
  },
  preset: {
    run: ({ p }) => {
      slider(p[6], p[1], p[0], -4, 7, 7, 0);
      slider(p[7], p[3], p[2], 3, 5, 9, 70);
      slider(p[8], p[5], p[4], -4, 9, 5, 140);
    },
  },
  preview: {
    run: ({ p }) => {
      squash(p[3], 0.94, 0.94);
      popIn(p[0], { delay: 70 });
    },
  },
  queue: {
    run: ({ p }) => {
      squash(p[0], 1.04, 0.9, { origin: "center bottom" });
      [1, 2].forEach((n, i) => nudge(p[n], 0, 2.4, { delay: 40 + i * 70 }));
    },
  },
  refresh: { run: ({ all }) => chain(all, "none", [["rotate(-28deg)", q(140, EASE.inOut)], ["rotate(180deg)", "snappy"]]) },
  reset: { run: ({ all }) => chain(all, "none", [["rotate(28deg)", q(140, EASE.inOut)], ["rotate(-360deg)", "snappy"]]) },
  undo: {
    run: ({ all }) =>
      chain(all, "none", [["rotate(16deg)", q(110)], ["rotate(-34deg)", q(170, EASE.inOut)], ["none", "bouncy"]], {
        origin: "vb 12 12",
      }),
  },
  save: {
    run: ({ p, all }) => {
      squash(all, 1.04, 0.9, { origin: "center bottom" });
      chain(p[2], "none", [[T(0, -2.4), q(120)], ["none", "bouncy"]], { delay: 70 });
    },
  },
  secure: {
    run: ({ p }) => {
      pulse(p[0], 0.88);
      draw(p[1], 320, 120);
    },
  },
  settings: { run: ({ all }) => chain(all, "none", [["rotate(-24deg)", q(140, EASE.inOut)], ["rotate(180deg)", "bouncy"]]) },
  source: {
    run: ({ p, all }) => {
      chain(p[1], "none", [["scaleX(-1)", q(460, EASE.inOut)]]);
      pulse(all, 0.92);
    },
  },
  sparkle: {
    run: ({ p }) => {
      chain(p[0], "none", [["scale(.7) rotate(-24deg)", q(120)], ["none", "bouncy"]]);
      popIn([p[1], p[2]], { delay: 90 });
      popIn([p[3], p[4]], { delay: 170 });
    },
  },
  status: {
    run: ({ p }) => {
      popIn(p[1]);
      pulse(p[0], 0.9, { delay: 40 });
    },
  },
  stop: { run: ({ all }) => chain(all, "none", [["scale(.78) rotate(-12deg)", q(110)], ["rotate(90deg)", "bouncy"]]) },
  time: {
    run: ({ p, all }) => {
      chain(p[1], "none", [["rotate(-24deg)", q(120, EASE.inOut)], ["rotate(360deg)", "snappy"]], { origin: "vb 12 12" });
      pulse(all, 0.92, { delay: 20 });
    },
  },
  trash: {
    groups: { lid: [0, 2], can: [1, 3, 4] },
    run: ({ g }) => {
      const open = "translate(-.4px,-3px) rotate(-18deg)";
      chain(g.lid, "none", [
        [open, q(160)],
        [open, q(110, "linear")],
        ["none", q(120, EASE.in)],
        [T(0, -0.9), q(80)],
        ["none", "bouncy"],
      ], { origin: "left bottom" });
      squash(g.can, 1.06, 0.9, { delay: 400, origin: "center bottom" });
    },
  },
  video: {
    run: ({ p }) => {
      nudge(p[0], 2.4, 0, { s: "wobbly" });
      squash(p[1], 0.92, 1, { origin: "left center" });
    },
  },
  hls: { run: ({ all }) => chain(all, "none", [[T(0, -3), q(220)], ["none", "soft"]]) },
  twitch: {
    run: ({ all }) =>
      chain(all, "none", [["scale(1.08,.88)", q(90)], ["translate(0px,-3px) scale(.95,1.05)", q(140)], ["none", "bouncy"]], {
        origin: "center bottom",
      }),
  },
  wtv: {
    run: ({ p }) => {
      squash(p[0], 1.06, 0.88, { origin: "center bottom" });
      nudge([p[1], p[2], p[3], p[4]], -1.6, -1.6, { delay: 60 });
    },
  },
  kick: { run: ({ all }) => squash(all, 0.84, 0.84) },
  rtmp: {
    groups: { up: [1, 2] },
    clips: { up: [7, 8.5, 10, 10] },
    run: ({ g, p }) => {
      squash(p[0], 1.05, 0.92, { origin: "center bottom" });
      through(g.up, 0, -9, { s: "bouncy", delay: 40 });
    },
  },
  vk: { run: ({ all }) => squash(all, 1.14, 0.86) },
  youtube: {
    groups: { pl: [1] },
    clips: { pl: [7, 6.5, 10, 11] },
    run: ({ g, p }) => {
      squash(p[0], 0.92, 0.92);
      through(g.pl, 8, 0, { s: "bouncy", delay: 40 });
    },
  },
};

const ALIASES: Record<string, string> = {
  check: "apply",
  clear: "close",
  minimize: "priorityNormal",
  local: "folder",
  unknown: "source",
};

export function getChoreography(key: string): Choreography | undefined {
  return D[key] ?? D[ALIASES[key] ?? ""];
}
