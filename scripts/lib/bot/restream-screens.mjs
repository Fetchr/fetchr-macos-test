/** Screens of the «📡 Рестрим» section. `view` is what the recorder's
 *  GET /restream returns: limits, platforms, recorded channels, folders with
 *  masked keys and live status. */

import { backBtn, btn, esc, keyboard, menuBtn } from "./ui.mjs";

const STATE = {
  live: ["🟢", "в эфире"],
  starting: ["🟡", "запускается"],
  waiting: ["⚪", "ждёт эфира"],
  error: ["🔴", "ошибка"],
  off: ["⏸", "выключен"],
};

export const PLATFORM_HELP = {
  youtube: "YouTube Studio → Создать → Начать трансляцию → «Ключ трансляции».",
  twitch: "Twitch → Панель управления автора → Настройки → Трансляция → «Основной ключ трансляции».",
  kick: "Kick → Dashboard → Settings → Stream URL & Key: пришлите сначала Stream URL, потом Stream Key.",
  vk: "VK Видео → Студия → Трансляция → «Настроить в программе»: сначала URL, потом ключ.",
  rutube: "Rutube Студия → Трансляции → Создать: сначала «URL сервера», потом «Ключ трансляции».",
  custom: "Любой сервер RTMP/RTMPS: сначала адрес сервера (rtmp://… или rtmps://…), потом ключ потока.",
};

const platformName = (view, id) => view.platforms?.[id]?.name || id;
const totalOutputs = (view) => view.folders.reduce((sum, folder) => sum + folder.outputs.length, 0);

function stateOf(view, channel) {
  const status = view.status?.[channel];
  const [icon, text] = STATE[status?.state] || STATE.waiting;
  return { icon, text, error: status?.state === "error" ? status.error : null };
}

export function noTenantScreen() {
  return {
    media: "rs-none",
    text: [
      "📡 <b>Рестрим</b>",
      "",
      "Рестрим работает поверх Архива VPS: сервер пишет эфир и тут же отправляет его на ваши площадки.",
      "",
      "Сначала подключите тариф Архива VPS и добавьте стримера в приложении Fetchr.",
    ].join("\n"),
    markup: keyboard([[btn("💾 Тарифы", "shop:rub", "primary")], [menuBtn()]]),
  };
}

export function notConnectedScreen() {
  return {
    media: "rs-off",
    text: [
      "📡 <b>Рестрим</b>",
      "",
      "Ваш эфир из архива уходит на YouTube, VK, Kick, Rutube или свой RTMP — в исходном качестве.",
      "",
      "От 100 ₽ в месяц, подключается в магазине.",
    ].join("\n"),
    markup: keyboard([[btn("➕ Подключить рестрим", "ad:rub:c0r1e0:1", "primary")], [menuBtn()]]),
  };
}

export function restreamHomeScreen({ view, notice = "" }) {
  const { limits, folders } = view;
  return {
    media: "rs-home",
    art: { outputs: totalOutputs(view) },
    text: [
      ...(notice ? [notice, ""] : []),
      `📡 <b>Рестрим</b> · стримеров ${folders.length}/${limits.streamers} · площадок ${totalOutputs(view)}/${limits.outputs}`,
      "",
      folders.length ? "Нажмите на стримера, чтобы настроить площадки." : "Добавьте стримера из вашего архива.",
    ].join("\n"),
    markup: keyboard([
      ...folders.map((folder, i) => {
        const state = folder.enabled ? stateOf(view, folder.channel) : { icon: "⏸", text: "выключен" };
        const targets = folder.outputs.filter((o) => o.enabled).map((o) => platformName(view, o.platform)).join(", ") || "нет площадок";
        return [btn(`${state.icon} ${folder.channel} → ${targets}`, `rs:f:${i}`)];
      }),
      ...(folders.length < limits.streamers ? [[btn("➕ Добавить стримера", "rs:add", "success")]] : []),
      [btn("🔄 Обновить", "rs"), btn("➕ Больше мест", "ad:rub")],
      [menuBtn()],
    ]),
  };
}

export function pickChannelScreen({ view }) {
  const used = new Set(view.folders.map((folder) => folder.channel));
  const free = view.channels.filter((channel) => !used.has(channel));
  return {
    media: "rs-channel",
    text: [
      "📡 <b>Какого стримера ретранслировать?</b>",
      "",
      free.length
        ? "Рестрим берёт эфир из записи, поэтому доступны стримеры, которые уже записываются в ваш архив."
        : "Свободных стримеров нет: все записываемые уже в рестриме. Добавьте стримера в приложении Fetchr (раздел «VPS-архив»).",
    ].join("\n"),
    markup: keyboard([...free.map((channel) => [btn(channel, `rs:n:${channel}`)]), [backBtn("rs", "Рестрим")]]),
  };
}

export function confirmOwnScreen({ channel }) {
  return {
    media: "rs-own",
    art: { channel: String(channel) },
    text: [
      `📡 <b>Рестрим ${esc(channel)}</b>`,
      "",
      "Ретранслировать можно только свой канал или с разрешения автора — иначе рестрим отключим.",
    ].join("\n"),
    markup: keyboard([[btn("✅ Это мой канал / есть разрешение", `rs:y:${channel}`, "success")], [backBtn("rs:add")]]),
  };
}

export function folderScreen({ view, index, notice = "" }) {
  const folder = view.folders[index];
  const state = stateOf(view, folder.channel);
  const room = totalOutputs(view) < view.limits.outputs && folder.outputs.length < 1 + view.limits.extra_per_streamer;
  return {
    media: "rs-folder",
    art: { channel: String(folder.channel) },
    text: [
      ...(notice ? [notice, ""] : []),
      `👤 <b>${esc(folder.channel)}</b> · ${folder.enabled ? `${state.icon} ${state.text}` : "⏸ выключен"}`,
      "",
      folder.outputs.length
        ? `<blockquote>${folder.outputs.map((o) => {
          const live = (view.status?.[folder.channel]?.outputs || []).find((s) => s?.id === o.id);
          const icon = !o.enabled ? "⏸" : (STATE[live?.state] || STATE.waiting)[0];
          const problem = o.enabled && live?.state === "error" && live.error ? `\n   ⚠️ <i>${esc(String(live.error).slice(0, 160))}</i>` : "";
          return `${icon} ${esc(platformName(view, o.platform))} · ключ ${esc(o.key_hint || "")}${problem}`;
        }).join("\n")}</blockquote>`
        : "Площадок пока нет — добавьте первую.",
      ...(state.error ? ["", `⚠️ <i>${esc(String(state.error).slice(0, 300))}</i>`] : []),
    ].join("\n"),
    markup: keyboard([
      ...folder.outputs.map((o, j) => [
        btn(`${o.enabled ? "⏸ Выключить" : "▶️ Включить"} ${platformName(view, o.platform)}`, `rs:t:${index}:${j}`),
        btn("🗑", `rs:d:${index}:${j}`),
      ]),
      ...(room ? [[btn("➕ Добавить площадку", `rs:p:${index}`, "success")]] : []),
      [btn(folder.enabled ? "⏸ Остановить рестрим" : "▶️ Включить рестрим", `rs:o:${index}`), btn("🗑 Убрать стримера", `rs:rm:${index}`)],
      [backBtn("rs", "Рестрим")],
    ]),
  };
}

export function pickPlatformScreen({ view, index }) {
  const ids = Object.keys(view.platforms || {});
  return {
    media: "rs-platform",
    text: `➕ <b>Куда ретранслировать ${esc(view.folders[index].channel)}?</b>`,
    markup: keyboard([
      ...ids.reduce((rows, id, i) => {
        if (i % 2 === 0) rows.push([]);
        rows.at(-1).push(btn(platformName(view, id), `rs:pp:${index}:${id}`));
        return rows;
      }, []),
      [backBtn(`rs:f:${index}`)],
    ]),
  };
}

export function askScreen({ view, index, platform, step }) {
  const name = platformName(view, platform);
  return {
    media: "rs-ask",
    art: { platform: platformName(view, platform) },
    text: [
      `🔑 <b>${esc(name)} для ${esc(view.folders[index].channel)}</b>`,
      "",
      PLATFORM_HELP[platform] || "",
      "",
      step === "url"
        ? "Пришлите сообщением <b>адрес сервера</b> (начинается с rtmp:// или rtmps://)."
        : "Пришлите сообщением <b>ключ трансляции</b>. Сообщение с ключом бот сразу удалит из чата.",
    ].join("\n"),
    markup: keyboard([[btn("Отмена", `rs:f:${index}`)]]),
  };
}

export function confirmRemoveScreen({ view, index }) {
  return {
    media: "rs-remove",
    text: `🗑 Убрать <b>${esc(view.folders[index].channel)}</b> из рестрима? Ключи его площадок удалятся с сервера.`,
    markup: keyboard([[btn("Да, убрать", `rs:rmy:${index}`, "danger")], [backBtn(`rs:f:${index}`)]]),
  };
}
