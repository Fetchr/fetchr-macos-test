import assert from "node:assert/strict";
import { test } from "node:test";

import { applyProfile, botProfile } from "./profile.mjs";

function fakeApi(current) {
  const calls = [];
  const api = async (method, body) => {
    calls.push({ method, body });
    if (method === "getMyDescription") return { description: current.description };
    if (method === "getMyShortDescription") return { short_description: current.short };
    return true;
  };
  return { api, calls, last: (method) => calls.filter((call) => call.method === method).at(-1)?.body };
}

const log = { error() {} };

test("the profile texts follow the site: what Fetchr does, the key, the archive from its lowest price", () => {
  const shop = botProfile({ shop: true });
  assert.match(shop.description, /готовит исходники к монтажу/);
  assert.match(shop.description, /от 100 ₽\/мес/);
  assert.ok(shop.shortDescription.length <= 120);
  assert.doesNotMatch(botProfile({ shop: false }).description, /Архив VPS/);
  assert.deepEqual(shop.commands.map((command) => command.command), ["start", "register", "shop", "support", "paysupport", "terms"]);
});

test("texts an older bot version set are replaced; hand-written ones are left alone", async () => {
  const old = fakeApi({
    description: "Fetchr — премиальный стрим-конвейер.\n\n🔑 Бесплатный ключ активации приложения\n🛒 Архив VPS — облачная запись стримов\n💬 Поддержка прямо в чате",
    short: "Ключ активации Fetchr, тарифы Архива VPS и поддержка.",
  });
  await applyProfile(old.api, { shop: true }, log);
  assert.equal(old.last("setMyDescription").description, botProfile({ shop: true }).description);
  assert.equal(old.last("setMyShortDescription").short_description, botProfile({ shop: true }).shortDescription);

  const manual = fakeApi({ description: "Написано руками", short: "Тоже руками" });
  await applyProfile(manual.api, { shop: true }, log);
  assert.equal(manual.last("setMyDescription"), undefined);
  assert.equal(manual.last("setMyShortDescription"), undefined);
});
