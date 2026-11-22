/** HTML and inline-keyboard helpers. Every user-supplied string that reaches a
 *  message goes through `esc`: parse_mode HTML rejects the whole message on a
 *  stray `<`, and an unescaped name could otherwise inject a link. */

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `style` is Bot API 9.4: "primary" (blue), "success" (green) or "danger"
 *  (red). Older clients ignore it and draw a plain button. `icon` names a
 *  Fetchr Line sign (premium-emoji.mjs); delivery always removes the field. */
export function btn(text, data, style, icon) {
  return { text, callback_data: data, ...(style ? { style } : {}), ...(icon ? { icon } : {}) };
}

export function urlBtn(text, url, style, icon) {
  return { text, url, ...(style ? { style } : {}), ...(icon ? { icon } : {}) };
}

/** Bot API 7.11: copies `value` to the clipboard on tap. Telegram takes
 *  1–256 characters; a longer value gets no button (null), so callers fall
 *  back to the tap-to-copy <pre> block. */
export const COPY_TEXT_MAX = 256;
export function copyBtn(text, value, style, icon) {
  const copy = String(value ?? "");
  if (!copy || copy.length > COPY_TEXT_MAX) return null;
  return { text, copy_text: { text: copy }, ...(style ? { style } : {}), ...(icon ? { icon } : {}) };
}

/** The same way back and home on every screen. */
export const backBtn = (data, label = "Назад") => btn(`← ${label}`, data, undefined, "back");
export const menuBtn = () => btn("🏠 Меню", "home");

export function keyboard(rows) {
  return {
    inline_keyboard: rows
      .filter((row) => Array.isArray(row))
      .map((row) => row.filter(Boolean))
      .filter((row) => row.length > 0),
  };
}

export function displayName(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return name || (user?.username ? `@${user.username}` : `id ${user?.id ?? "?"}`);
}

/** "Имя · @user · id" with a tappable name, for the admin side. */
export function userCard(user) {
  const parts = [`<a href="tg://user?id=${Number(user?.id) || 0}">${esc(displayName(user))}</a>`];
  if (user?.username) parts.push(`@${esc(user.username)}`);
  parts.push(`<code>${Number(user?.id) || 0}</code>`);
  return parts.join(" · ");
}

export function maskMachineId(machineId) {
  const id = String(machineId || "").toUpperCase();
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

export function fmtDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (part) => String(part).padStart(2, "0");
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
}

/** Russian plural: plural(2, ["устройство", "устройства", "устройств"]). */
export function plural(count, forms) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}
