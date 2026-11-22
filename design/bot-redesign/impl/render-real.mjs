/* Renders covers with the art the real screens pass (planScreen, paidScreen, registration). */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { coverSvg } from "../../../scripts/lib/bot/covers.mjs";
import { PLANS } from "../../../scripts/lib/bot/catalog.mjs";
import { planScreen, paidScreen } from "../../../scripts/lib/bot/shop-screens.mjs";

process.env.FETCHR_BOT_PROMO = "off";
const fontsDir = fileURLToPath(new URL("../../../scripts/assets/fonts/", import.meta.url));
const out = (name, screen) => writeFileSync(new URL(`./real-${name}.png`, import.meta.url),
  new Resvg(coverSvg(screen.media, screen.art), { fitTo: { mode: "width", value: 640 }, font: { fontDirs: [fontsDir], loadSystemFonts: false, defaultFontFamily: "Inter" } }).render().asPng());
const streamer = PLANS.find((plan) => plan.id === "streamer");
const mini = PLANS.find((plan) => plan.id === "mini");
out("plan-12", planScreen({ plan: streamer, currency: "rub", packs: 0, months: 12, registered: true }));
out("plan-mini", planScreen({ plan: mini, currency: "rub", packs: 3, months: 1, registered: true }));
out("paid", paidScreen({ order: { id: "A7F3K2", amount: 4800, months: 12, quota_gb: 150, method: "robokassa" }, plan: streamer }));
