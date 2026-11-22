import { createElement, useId, type CSSProperties, type ReactNode, type SVGProps } from "react";
import type { IconNode } from "lucide-react";

import { getChoreography } from "./choreography";
import { getTone } from "./tone";
import "./motion.css";

export interface MotionSvgProps extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  motionKey: string;
  node: IconNode;
  size?: number | string;
  absoluteStrokeWidth?: boolean;
}

/** Lucide-compatible SVG whose children carry indices, groups and clips that the motion runtime animates. */
export function MotionSvg({
  motionKey,
  node,
  size = 24,
  color = "currentColor",
  strokeWidth = 2,
  absoluteStrokeWidth,
  ...rest
}: MotionSvgProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const stroke = absoluteStrokeWidth ? (Number(strokeWidth) * 24) / Number(size) : strokeWidth;
  const def = getChoreography(motionKey);
  const tone = getTone(motionKey, node);
  const toned = new Set(tone.indices);
  const children = node.map(([tag, attrs], i) =>
    createElement(tag, {
      ...attrs,
      key: i,
      pathLength: 1,
      "data-i": i,
      ...(toned.has(i) ? { "data-tone": "" } : {}),
    }),
  );
  const extraTone = (tone.extra ?? []).map(([tag, attrs], i) =>
    createElement(tag, { ...attrs, key: `tone-${i}`, "data-tone": "", "data-tone-extra": "" }),
  );

  const owner = new Map<number, string>();
  for (const [name, indices] of Object.entries(def?.groups ?? {})) indices.forEach((i) => owner.set(i, name));
  const clips = def?.clips ?? {};
  const clipDefs: ReactNode[] = [];
  const wrapClip = (name: string, inner: ReactNode): ReactNode => {
    const rect = clips[name];
    if (!rect) return inner;
    const id = `${uid}-${name}`;
    clipDefs.push(
      <clipPath id={id} key={id}>
        <rect x={rect[0]} y={rect[1]} width={rect[2]} height={rect[3]} />
      </clipPath>,
    );
    return (
      <g clipPath={`url(#${id})`} key={`clip-${name}`}>
        {inner}
      </g>
    );
  };

  const body: ReactNode[] = [];
  const emitted = new Set<string>();
  children.forEach((child, i) => {
    const name = owner.get(i);
    if (name === undefined) {
      body.push(child);
      return;
    }
    if (emitted.has(name)) return;
    emitted.add(name);
    const members = (def?.groups?.[name] ?? []).map((j) => children[j]);
    body.push(
      wrapClip(
        name,
        <g data-g={name} key={`g-${name}`}>
          {members}
        </g>,
      ),
    );
  });
  const content = wrapClip(
    "all",
    <g data-all="">
      {extraTone}
      {body}
    </g>,
  );

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-mi={motionKey}
      {...rest}
      style={{ "--icon-sw": stroke, ...rest.style } as CSSProperties}
    >
      {clipDefs.length > 0 && <defs>{clipDefs}</defs>}
      {content}
    </svg>
  );
}
