/** Support relay. A user's message is copied to every admin chat under a
 *  header; an admin's reply to either of them goes back to the user. Replies
 *  in both directions stay on the same ticket, so a conversation never needs
 *  ticket numbers typed by hand. */

import { TelegramError } from "./telegram-api.mjs";
import { esc } from "./ui.mjs";
import {
  adminTicketHeader,
  supportAnswerMarkup,
  supportAnswerText,
  supportPromptScreen,
  supportScreen,
  supportSentScreen,
} from "./screens.mjs";

const TOO_FAST = "⏳ Слишком много сообщений подряд — подождите пару минут и напишите снова.";
const NO_ADMINS = "⚠️ Поддержка сейчас недоступна. Попробуйте чуть позже.";

export function createSupport({ api, config, tickets, sessions, licenses, orders, adminChats, limiter, show, send, log }) {
  const shop = Boolean(config?.shopEnabled);
  async function deliverToAdmins(message, ticket, followUp) {
    const chats = await adminChats();
    let delivered = 0;
    for (const chatId of chats) {
      try {
        const header = await send(chatId, {
          text: adminTicketHeader({
            ticket,
            user: message.from,
            deviceCount: licenses.devices(message.from.id).length,
            orderCount: orders.countForUser(message.from.id),
            followUp,
          }),
        });
        tickets.link(ticket.id, chatId, header.message_id);
        const copy = await api("copyMessage", {
          chat_id: chatId,
          from_chat_id: message.chat.id,
          message_id: message.message_id,
          reply_parameters: { message_id: header.message_id },
        });
        tickets.link(ticket.id, chatId, copy.message_id);
        delivered += 1;
      } catch (err) {
        log.error(`Ticket #${ticket.id} to admin chat ${chatId} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return delivered;
  }

  return {
    open(chatId, messageId, { payment = false, shop = false } = {}) {
      return show(chatId, messageId, supportScreen({ payment, shop }));
    },

    startWriting(chatId, messageId, from, { kind = "support", ticketId = null } = {}) {
      sessions.set(from.id, { awaiting: "support", supportKind: kind, ticketId });
      return show(chatId, messageId, supportPromptScreen());
    },

    cancel(chatId, messageId, from) {
      sessions.set(from.id, { awaiting: null });
      return show(chatId, messageId, supportScreen({ shop }));
    },

    /** Ticket the user may continue, if `ticketId` is theirs. */
    ownTicket(from, ticketId) {
      const ticket = tickets.get(ticketId);
      return ticket && ticket.user_id === from.id ? ticket : null;
    },

    async fromUser(message, existing = null) {
      const { from } = message;
      if (!limiter(from.id)) return send(message.chat.id, { text: TOO_FAST });
      if ((await adminChats()).length === 0) {
        log.error("Support message dropped: no admin chats configured or detected");
        return send(message.chat.id, { text: NO_ADMINS });
      }
      const session = sessions.get(from.id);
      const ticket =
        existing || tickets.open({ kind: session.supportKind || "support", user_id: from.id, chat_id: message.chat.id });
      sessions.set(from.id, { awaiting: null, ticketId: ticket.id });
      if ((await deliverToAdmins(message, ticket, Boolean(existing))) === 0) {
        return send(message.chat.id, { text: NO_ADMINS });
      }
      const sent = await send(message.chat.id, supportSentScreen({ ticketId: ticket.id }));
      tickets.link(ticket.id, message.chat.id, sent.message_id);
      return sent;
    },

    /** Returns false when the admin's message is not a reply to a ticket. */
    async fromAdmin(message) {
      const ticket = tickets.find(message.chat.id, message.reply_to_message?.message_id);
      if (!ticket) return false;
      const markup = supportAnswerMarkup(ticket.id);
      try {
        let sent;
        if (message.text) {
          sent = await send(ticket.chat_id, { text: supportAnswerText({ ticket, text: message.text }), markup });
        } else {
          await send(ticket.chat_id, { text: supportAnswerText({ ticket, text: "" }) });
          sent = await api("copyMessage", {
            chat_id: ticket.chat_id,
            from_chat_id: message.chat.id,
            message_id: message.message_id,
            reply_markup: markup,
          });
        }
        tickets.link(ticket.id, ticket.chat_id, sent.message_id);
        sessions.set(ticket.user_id, { ticketId: ticket.id });
      } catch (err) {
        const blocked = err instanceof TelegramError && err.code === 403;
        await send(message.chat.id, {
          text: blocked
            ? "⚠️ Не доставлено: пользователь заблокировал бота."
            : `⚠️ Не доставлено: ${esc(err instanceof Error ? err.message : err)}`,
        });
        return true;
      }
      try {
        await api("setMessageReaction", {
          chat_id: message.chat.id,
          message_id: message.message_id,
          reaction: [{ type: "emoji", emoji: "👌" }],
        });
      } catch {
        await send(message.chat.id, { text: "✓ Доставлено" });
      }
      return true;
    },
  };
}
