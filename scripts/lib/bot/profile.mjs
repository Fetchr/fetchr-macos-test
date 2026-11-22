/** The bot's profile: command menu and the texts shown on an empty chat and
 *  on the profile page. They follow whether the shop is open. The avatar and
 *  the description picture are set by hand in @BotFather. */

import { SALE_PLANS, fmtPrice } from "./catalog.mjs";

const fromPrice = () => fmtPrice(Math.min(...SALE_PLANS.map((plan) => plan.price.rub).filter((price) => price > 0)));

function describe(shop) {
  return {
    commands: [
      { command: "start", description: "Главное меню" },
      { command: "register", description: "Ключ за минуту" },
      ...(shop ? [{ command: "shop", description: "Архив VPS — тарифы" }] : []),
      { command: "support", description: "Написать в поддержку" },
      ...(shop
        ? [
            { command: "paysupport", description: "Вопрос по оплате" },
            { command: "terms", description: "Оферта и возврат" },
          ]
        : []),
    ],
    description: [
      "Fetchr готовит исходники к монтажу: глушит мат, делит голос и музыку, блюрит рекламу, рендерит чат слоем.",
      "",
      "🔑 Ключ приложения — бесплатно, за минуту",
      ...(shop ? [`🗄 Архив VPS — сервер пишет стримы 24/7, от ${fromPrice()}/мес`] : []),
      "💬 Поддержка — отвечаем в этом чате",
    ].join("\n"),
    shortDescription: shop
      ? "Бесплатный ключ Fetchr за минуту · Архив VPS пишет стримы без ПК · поддержка. fetchr.fun"
      : "Бесплатный ключ Fetchr за минуту и поддержка прямо в чате. fetchr.fun",
  };
}

export function botProfile({ shop }) {
  return describe(shop);
}

/** Texts earlier versions of the bot set: still ours, so they get replaced.
 *  Anything else was written by hand in @BotFather and is left alone. */
const LEGACY = [
  {
    description: [
      "Fetchr — премиальный стрим-конвейер.",
      "",
      "🔑 Бесплатный ключ активации приложения",
      "🛒 Архив VPS — облачная запись стримов",
      "💬 Поддержка прямо в чате",
    ].join("\n"),
    shortDescription: "Ключ активации Fetchr, тарифы Архива VPS и поддержка.",
  },
  {
    description: ["Fetchr — премиальный стрим-конвейер.", "", "🔑 Бесплатный ключ активации приложения", "💬 Поддержка прямо в чате"].join("\n"),
    shortDescription: "Ключ активации Fetchr и поддержка прямо в чате.",
  },
];
const OWN = [describe(true), describe(false), ...LEGACY];

export async function applyProfile(api, { shop }, log) {
  const profile = describe(shop);
  const steps = [
    // No Mini App: the chat's menu button is the command list.
    () => api("setChatMenuButton", { menu_button: { type: "commands" } }),
    () => api("setMyCommands", { commands: profile.commands }),
    async () => {
      const current = (await api("getMyDescription"))?.description || "";
      const ours = !current || OWN.some((own) => own.description === current);
      if (ours && current !== profile.description) {
        await api("setMyDescription", { description: profile.description });
      }
    },
    async () => {
      const current = (await api("getMyShortDescription"))?.short_description || "";
      const ours = !current || OWN.some((own) => own.shortDescription === current);
      if (ours && current !== profile.shortDescription) {
        await api("setMyShortDescription", { short_description: profile.shortDescription });
      }
    },
  ];
  for (const step of steps) {
    await step().catch((err) => log.error(`Profile setup failed: ${err instanceof Error ? err.message : err}`));
  }
}
