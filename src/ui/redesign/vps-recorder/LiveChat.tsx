import { useEffect, useRef, useState } from "react";

import { ipc, type VpsChatFragment, type VpsChatMessage } from "@/lib/ipc";
import { useSettings } from "@/stores/settings";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { ChatLine } from "./ChatLine";
import { parseIrcMessage } from "@/lib/chatFragments";
import styles from "./VpsRecorderPage.module.css";

const WINDOW = 200;
const RECONNECT_MS = 4000;

type Phase = "connecting" | "online" | "offline";

/**
 * Twitch chat as it happens, relayed straight from IRC.
 *
 * A live session's chat.json is still being appended to on the server, so
 * replaying it would always lag behind the picture. Reading the same anonymous
 * IRC feed the recorder reads gives the stream's chat in real time.
 */
export function LiveChat({ channel }: { channel: string }) {
  const proxy = useSettings((state) => state.proxy);
  // Each line carries a running number: an index key shifted once the window
  // was full and remounted all 200 lines on every new message.
  const [messages, setMessages] = useState<Array<{ id: number; message: VpsChatMessage }>>([]);
  const seqRef = useRef(0);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [emoteCount, setEmoteCount] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const emotesRef = useRef<Record<string, VpsChatFragment>>({});

  // Emote sets first: a message that arrives before them would render as plain
  // text and stay that way, since lines are never re-parsed.
  useEffect(() => {
    let cancelled = false;
    emotesRef.current = {};
    setEmoteCount(null);
    void ipc
      .vpsChannelEmotes(channel, proxy)
      .then((map) => {
        if (cancelled) return;
        emotesRef.current = map;
        setEmoteCount(Object.keys(map).length);
      })
      .catch(() => {
        if (!cancelled) setEmoteCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [channel, proxy]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | null = null;
    let closed = false;
    const started = Date.now();

    const connect = () => {
      if (closed) return;
      setPhase("connecting");
      socket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");

      socket.onopen = () => {
        // Anonymous read-only login: justinfan<random> needs no token.
        socket?.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
        socket?.send(`NICK justinfan${Math.floor(Math.random() * 80000 + 1000)}`);
        socket?.send(`JOIN #${channel}`);
        setPhase("online");
      };

      socket.onmessage = (event) => {
        const batch: Array<{ id: number; message: VpsChatMessage }> = [];
        for (const line of String(event.data).split("\r\n")) {
          if (!line) continue;
          if (line.startsWith("PING")) {
            socket?.send("PONG :tmi.twitch.tv");
            continue;
          }
          const parsed = parseIrcMessage(line, emotesRef.current, (Date.now() - started) / 1000);
          if (parsed) {
            seqRef.current += 1;
            batch.push({ id: seqRef.current, message: parsed });
          }
        }
        if (batch.length > 0) {
          setMessages((current) => [...current, ...batch].slice(-WINDOW));
        }
      };

      socket.onclose = () => {
        if (closed) return;
        setPhase("offline");
        retry = window.setTimeout(connect, RECONNECT_MS);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      closed = true;
      if (retry !== null) window.clearTimeout(retry);
      socket?.close();
    };
  }, [channel]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !pinnedRef.current) return;
    body.scrollTop = body.scrollHeight;
  }, [messages]);

  return (
    <div className={styles.chatSlot}>
      <div className={styles.chatPanel}>
        <div className={styles.chatHeader}>
          <RedesignIcon name="chat" />
          <span>Прямой чат Twitch</span>
          <span className={styles.barSpacer} />
          <span
            className={styles.tabCount}
            title={
              phase === "online"
                ? `Подключено к чату ${channel}`
                : phase === "connecting"
                  ? "Подключение к чату Twitch"
                  : "Соединение потеряно, переподключаюсь"
            }
          >
            {phase === "online" ? "live" : phase === "connecting" ? "…" : "нет связи"}
          </span>
          {emoteCount != null && (
            <span
              className={styles.tabCount}
              title={
                emoteCount > 0
                  ? "Эмоутов BTTV/FFZ/7TV загружено"
                  : "Эмоуты BTTV/FFZ/7TV не загрузились — подробности в Логах"
              }
            >
              {emoteCount > 0 ? `+${emoteCount}` : "—"}
            </span>
          )}
        </div>
        <div
          className={styles.chatBody}
          ref={bodyRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {messages.length === 0 && (
            <p className={styles.panelHelp}>
              {phase === "online" ? "Ждём сообщений…" : "Подключение к чату Twitch…"}
            </p>
          )}
          {messages.map((item) => (
            <ChatLine key={item.id} message={item.message} />
          ))}
        </div>
      </div>
    </div>
  );
}
