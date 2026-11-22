/** Which public custom emoji replaces each plain emoji in the bot's screens.
 *
 * One visual family: Telegram's own app icons, as redrawn in
 *   t.me/addemoji/tgiosicons      (iOS icons, catalog: emoji.wivvi.net)
 *   t.me/addemoji/TgAndroidIcons  (fills the gaps: key, card)
 * Both are monochrome and repaint to the text colour, so they read like the
 * Telegram UI itself. Emoji without a good match stay plain.
 *
 * `pick.mjs` checks every id against Telegram before writing the map. */

export const PICKS = Object.freeze([
  { char: "🔑", id: "6005570495603282482", note: "TgAndroidIcons · key" },
  { char: "🛒", id: "5920332557466997677", note: "tgiosicons · shop" },
  { char: "💬", id: "6037421444789440735", note: "tgiosicons · chats" },
  { char: "📡", id: "6048723247501938454", note: "tgiosicons · broadcast" },
  { char: "📢", id: "6021418126061605425", note: "tgiosicons · megaphone" },
  { char: "📣", id: "6021418126061605425", note: "tgiosicons · megaphone" },
  { char: "✅", id: "5774022692642492953", note: "tgiosicons · checkmark" },
  { char: "⚠", id: "6030563507299160824", note: "tgiosicons · attention" },
  { char: "🔥", id: "5890727932011223292", note: "tgiosicons · price tag" },
  { char: "💳", id: "5927169041595634481", note: "TgAndroidIcons · card" },
  { char: "💾", id: "6041730074376410123", note: "tgiosicons · archive" },
  { char: "🏠", id: "6042137469204303531", note: "tgiosicons · home" },
  { char: "⭐", id: "6034923938486684992", note: "tgiosicons · star" },
  { char: "🗓", id: "5890937706803894250", note: "tgiosicons · calendar" },
  { char: "⏳", id: "5891211339170326418", note: "tgiosicons · hourglass" },
  { char: "🔄", id: "6030657343744644592", note: "tgiosicons · repeat" },
  { char: "✍", id: "6039614175917903752", note: "tgiosicons · pencil" },
  { char: "➕", id: "5882207227997066107", note: "tgiosicons · add" },
  { char: "👤", id: "6035084557378654059", note: "tgiosicons · profile" },
  { char: "📄", id: "6050643982646513651", note: "tgiosicons · document" },
  { char: "💸", id: "5904359114531675993", note: "tgiosicons · withdraw" },
  { char: "🔒", id: "6037249452824072506", note: "tgiosicons · lock" },
  { char: "✖", id: "5774077015388852135", note: "tgiosicons · cross" },
  { char: "🎉", id: "6041731551845159060", note: "tgiosicons · hooray" },
  { char: "👑", id: "5805553606635559688", note: "tgiosicons · crown" },
  { char: "▶", id: "5773626993010546707", note: "tgiosicons · play" },
  { char: "🗑", id: "6039522349517115015", note: "tgiosicons · trash" },
  { char: "🔕", id: "6039569594157371705", note: "tgiosicons · notifications off" },
  { char: "👥", id: "6032594876506312598", note: "tgiosicons · group" },
]);
