import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { coverSvg } from "../../../scripts/lib/bot/covers.mjs";
import { homeCardSvg } from "../../../scripts/lib/bot/cards.mjs";

const fontsDir = fileURLToPath(new URL("../../../scripts/assets/fonts/", import.meta.url));
const out = (name, svg) =>
  writeFileSync(new URL(`./${name}.png`, import.meta.url), new Resvg(svg, { fitTo: { mode: "width", value: 640 }, font: { fontDirs: [fontsDir], loadSystemFonts: false, defaultFontFamily: "Inter" } }).render().asPng());

out("home", homeCardSvg({ name: "Миша", devices: 1, machineId: "7F3A…5A61", shop: true, subscription: null }));
out("home-new", homeCardSvg({ name: "Миша", devices: 0, shop: true, subscription: null }));
for (const [n, art] of [["register-1", { channel: "@streamcutter" }], ["register-2", {}], ["shop-2", { plan: "Стример", quota: "150 ГБ" }], ["shop-invoice", { price: "500 ₽", id: "A7F3K2" }], ["shop-1", {}], ["shop-3", { plan: "Стример", price: "500 ₽", months: "1 месяц" }], ["register-3", { fresh: true }], ["shop-done", { plan: "Стример" }], ["welcome", {}]]) out(n, coverSvg(n, art));
