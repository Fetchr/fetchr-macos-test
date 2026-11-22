/* Renders the implemented bot covers (scripts/lib/bot) for a visual check. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { COVER_NAMES, coverSvg } from "../../../scripts/lib/bot/covers.mjs";
import { homeCardSvg } from "../../../scripts/lib/bot/cards.mjs";

const fontsDir = fileURLToPath(new URL("../../../scripts/assets/fonts/", import.meta.url));
const out = (name, svg) => writeFileSync(new URL(`./${name}.png`, import.meta.url),
  new Resvg(svg, { fitTo: { mode: "width", value: 640 }, font: { fontDirs: [fontsDir], loadSystemFonts: false, defaultFontFamily: "Inter" } }).render().asPng());
const ART = {
  "register-1": { channel: "@streamcutter" },
  "shop-3": { id: "streamer", plan: "Стример", quota: "150 ГБ", hours: "≈ 52 ч", channels: "2", months: "12 месяцев", price: "4 800 ₽", full: "6 000 ₽", perMonth: "400 ₽", note: "−20% за срок · экономия 1 200 ₽" },
  "shop-done": { plan: "Стример", months: "12 месяцев", until: "18.11.2027", id: "A7F3K2" },
  "support-sent": { id: "1042" },
};
for (const name of COVER_NAMES) out(`cover-${name}`, coverSvg(name, ART[name] || {}));
out("home-new", homeCardSvg({ name: "Миша", devices: 0, shop: true }));
out("home-free", homeCardSvg({ name: "Миша", devices: 1, machineId: "7F3A…5A61", shop: true, subscription: null }));
out("home-paid", homeCardSvg({ name: "Миша", devices: 1, machineId: "7F3A…5A61", shop: true, promo: { percent: 40, until: "1 декабря" },
  subscription: { active: true, plan: "Стример", quota_gb: 150, days_left: 18, period_days: 30, paid_until: "2026-12-06T00:00:00Z" } }));
