import type { IconNode } from "lucide-react";

/** Duotone layer: which glyph children get the soft tone fill, plus extra fill-only shapes drawn under the glyph. */
export interface ToneSpec {
  indices: readonly number[];
  extra?: IconNode;
}

const TRAY: IconNode = [["path", { d: "M3 15h18v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }]];
const FOLDER_FRONT: IconNode = [
  ["path", { d: "M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4z" }],
];
const BIN: IconNode = [["path", { d: "M5 6h14v14c0 1-1 2-2 2H7c-1 0-2-1-2-2z" }]];

const OVERRIDES: Record<string, ToneSpec> = {
  bell: { indices: [1] },
  blur: { indices: [1] },
  kick: { indices: [] },
  vk: { indices: [] },
  wtv: { indices: [] },
  cpu: { indices: [0] },
  download: { indices: [], extra: TRAY },
  exportJson: { indices: [0] },
  fileAudio: { indices: [] },
  fileVideo: { indices: [0] },
  folder: { indices: [], extra: FOLDER_FRONT },
  local: { indices: [], extra: FOLDER_FRONT },
  image: { indices: [0] },
  performance: { indices: [1] },
  settings: { indices: [0] },
  trash: { indices: [], extra: BIN },
  twitch: { indices: [0] },
  visible: { indices: [0] },
  youtube: { indices: [0] },
};

function isClosed([tag, attrs]: IconNode[number]): boolean {
  if (tag === "rect" || tag === "ellipse" || tag === "polygon") return true;
  if (tag === "circle") return Number(attrs.r) > 1.5;
  return tag === "path" && /z\s*$/i.test(String(attrs.d ?? ""));
}

const cache = new Map<string, ToneSpec>();

export function getTone(key: string, node: IconNode): ToneSpec {
  const hit = cache.get(key);
  if (hit) return hit;
  const spec = OVERRIDES[key] ?? {
    indices: node.flatMap((child, i) => (isClosed(child) ? [i] : [])),
  };
  cache.set(key, spec);
  return spec;
}
