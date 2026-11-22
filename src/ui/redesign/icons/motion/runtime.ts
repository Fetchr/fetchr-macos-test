import { getChoreography } from "./choreography";
import { reducedMotion } from "./spring";

const INTERACTIVE =
  'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], summary';
const REPLAY_GAP_MS = 250;
const lastPlayed = new WeakMap<SVGSVGElement, number>();

/** Runs the icon's choreography from rest, cancelling any run still in flight (CSS animations are left alone). */
export function playIcon(svg: SVGSVGElement): void {
  const key = svg.dataset.mi;
  const def = key ? getChoreography(key) : undefined;
  if (!def || reducedMotion()) return;
  const now = performance.now();
  if (now - (lastPlayed.get(svg) ?? -Infinity) < REPLAY_GAP_MS) return;
  lastPlayed.set(svg, now);

  for (const animation of svg.getAnimations({ subtree: true })) {
    if (!(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition)) animation.cancel();
  }
  const g: Record<string, SVGElement> = {};
  svg.querySelectorAll<SVGElement>("[data-g]").forEach((el) => {
    if (el.dataset.g) g[el.dataset.g] = el;
  });
  const p: SVGElement[] = [];
  svg.querySelectorAll<SVGElement>("[data-i]").forEach((el) => {
    p[Number(el.dataset.i)] = el;
  });
  def.run({ g, p, all: svg.querySelector<SVGElement>("[data-all]") ?? undefined });
}

function ownIcons(host: Element): SVGSVGElement[] {
  return Array.from(host.querySelectorAll<SVGSVGElement>("svg[data-mi]")).filter(
    (svg) => svg.parentElement?.closest(INTERACTIVE) === host,
  );
}

function isDisabled(host: Element): boolean {
  return host.matches(":disabled, [aria-disabled='true']");
}

function onPress(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const host = target.closest(INTERACTIVE);
  if (!host || isDisabled(host)) return;
  ownIcons(host).forEach(playIcon);
}

let installed = false;

/** One delegated listener for the whole app: pressing a control (mouse, touch or keyboard) plays the icons inside it. */
export function installIconMotion(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("pointerdown", (e) => {
    if (e.button === 0) onPress(e);
  }, { passive: true });
  document.addEventListener("click", (e) => {
    if (e.detail === 0) onPress(e);
  });
}
