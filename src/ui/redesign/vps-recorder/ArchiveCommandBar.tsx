import { useCallback, useRef, useState } from "react";

import type { VpsClipMeta, VpsRecordingMeta } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { VpsArchiveSection } from "@/stores/vpsRecorder";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { ArchiveMenu, type ArchiveMenuItem, type MenuAnchor } from "./ArchiveMenu";
import type { ArchiveChannel } from "./archiveModel";
import styles from "./ArchiveCommandBar.module.css";
import { ArchiveSearch } from "./ArchiveSearch";
import type { SearchHit } from "./archiveSearchModel";
import { channelParts } from "./format";
import { ServerChip, SourceSwitch } from "./ServerStorage";

export type RecordingFilter = "all" | "live" | "withClips";

const FILTERS: { id: RecordingFilter; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "live", label: "В эфире" },
  { id: "withClips", label: "С клипами" },
];

/** Почему фильтр выключен: счётчик нулевой. */
const FILTER_EMPTY: Record<RecordingFilter, string | null> = {
  all: null,
  live: "Сейчас нет записей в эфире",
  withClips: "Нет записей с клипами",
};

const CHANNEL_STATE: Record<ArchiveChannel["state"], string | null> = {
  live: "в эфире, идёт запись",
  waiting: "сервер ждёт эфир и начнёт запись сам",
  idle: null,
};

interface ArchiveCommandBarProps {
  section: VpsArchiveSection;
  channel: string | null;
  channels: ArchiveChannel[];
  filterCounts: Record<RecordingFilter, number>;
  clipCount: number;
  online: boolean;
  query: string;
  onQuery: (value: string) => void;
  recordings: readonly VpsRecordingMeta[];
  clips: readonly VpsClipMeta[];
  onPick: (hit: SearchHit) => void;
  onFilter: (filter: RecordingFilter) => void;
  onChannel: (channel: string | null) => void;
  onSection: (section: VpsArchiveSection) => void;
}

export const isRecordingSection = (section: VpsArchiveSection): section is RecordingFilter =>
  section === "all" || section === "live" || section === "withClips";

/** Верх страницы: поиск, фильтры, каналы, клипы и сервер одной строкой. */
export function ArchiveCommandBar(props: ArchiveCommandBarProps) {
  const { section, channel, channels, clipCount, online, onChannel, onSection } = props;
  return (
    <div className={styles.bar} role="toolbar" aria-label="Архив">
      <ArchiveSearch
        query={props.query}
        onQuery={props.onQuery}
        recordings={props.recordings}
        clips={props.clips}
        onPick={props.onPick}
      />
      <FilterChips section={section} counts={props.filterCounts} onFilter={props.onFilter} />
      <div className={styles.channels} role="group" aria-label="Каналы">
        {channels.map((item) => (
          <ChannelChip
            key={item.name}
            item={item}
            active={channel?.toLowerCase() === item.name.toLowerCase()}
            onClick={() => onChannel(channel?.toLowerCase() === item.name.toLowerCase() ? null : item.name)}
          />
        ))}
      </div>
      <ChannelsMenu channels={channels} channel={channel} onChannel={onChannel} />
      <button
        type="button"
        className={styles.chip}
        aria-pressed={section === "clips"}
        onClick={() => onSection("clips")}
        title="Все клипы архива"
        aria-label={clipCount > 0 ? `Клипы: ${clipCount}` : "Клипы"}
      >
        <RedesignIcon name="media" className="size-3.5" />
        <span className={styles.chipLabel}>Клипы</span>
        {clipCount > 0 && <span className={styles.chipCount}>{clipCount}</span>}
      </button>
      <button
        type="button"
        className={styles.chip}
        aria-pressed={section === "channels"}
        onClick={() => onSection("channels")}
        title="Каналы и расписание"
        aria-label={channels.length ? "Каналы и расписание" : "Добавить канал"}
      >
        <RedesignIcon name="add" className="size-3.5" />
        <span className={styles.chipLabel}>{channels.length ? "Каналы" : "Добавить канал"}</span>
      </button>
      <span className={styles.spacer} />
      <SourceSwitch className={styles.barSwitch} />
      <ServerChip online={online} active={section === "server"} onOpen={() => onSection("server")} />
    </div>
  );
}

function FilterChips({
  section,
  counts,
  onFilter,
}: {
  section: VpsArchiveSection;
  counts: Record<RecordingFilter, number>;
  onFilter: (filter: RecordingFilter) => void;
}) {
  return (
    <div className={styles.filters} role="group" aria-label="Фильтр записей">
      {FILTERS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={styles.chip}
          aria-pressed={section === item.id}
          disabled={item.id !== "all" && counts[item.id] === 0 && section !== item.id}
          title={counts[item.id] === 0 ? (FILTER_EMPTY[item.id] ?? undefined) : undefined}
          onClick={() => onFilter(item.id)}
        >
          {item.label}
          {item.id !== "all" && counts[item.id] > 0 && <span className={styles.chipCount}>{counts[item.id]}</span>}
        </button>
      ))}
    </div>
  );
}

function ChannelChip({ item, active, onClick }: { item: ArchiveChannel; active: boolean; onClick: () => void }) {
  const state = CHANNEL_STATE[item.state];
  const { name } = channelParts(item.name);
  return (
    <button
      type="button"
      className={styles.chip}
      aria-pressed={active}
      onClick={onClick}
      title={state ? `${item.name} · ${state}` : item.name}
      aria-label={state ? `${item.name}, ${state}` : item.name}
    >
      {item.state !== "idle" && <span className={cn(styles.chipDot, item.state === "live" && styles.chipDotLive)} aria-hidden />}
      <span className={styles.chipName}>{name}</span>
      {item.recordings > 0 && <span className={styles.chipCount}>{item.recordings}</span>}
    </button>
  );
}

/** Узкая строка: каналы прячутся в чип «Каналы N ▾» с меню. */
function ChannelsMenu({
  channels,
  channel,
  onChannel,
}: {
  channels: ArchiveChannel[];
  channel: string | null;
  onChannel: (channel: string | null) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  // Нажатие на чип при открытом меню сначала закрывает его снаружи; без отметки клик открыл бы его снова.
  const closedAt = useRef(0);
  const close = useCallback((restoreFocus: boolean) => {
    closedAt.current = Date.now();
    setAnchor(null);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);
  if (channels.length === 0) return null;

  const open = () => {
    if (Date.now() - closedAt.current <= 250) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ x: rect.left, y: rect.bottom + 4, above: rect.top - 4 });
  };
  const current = channel?.toLowerCase() ?? null;
  const items: ArchiveMenuItem[] = [
    { id: "__all", label: "Все каналы", icon: current ? "media" : "check", onSelect: () => onChannel(null) },
    ...channels.map((item, index) => {
      const active = current === item.name.toLowerCase();
      return {
        id: item.name,
        label: channelParts(item.name).name,
        icon: active ? ("check" as const) : item.state === "live" ? ("live" as const) : ("video" as const),
        hint: [CHANNEL_STATE[item.state], item.recordings > 0 ? `записей: ${item.recordings}` : null]
          .filter(Boolean)
          .join(" · ") || undefined,
        separated: index === 0,
        onSelect: () => onChannel(active ? null : item.name),
      };
    }),
  ];
  const picked = current ? channels.find((item) => item.name.toLowerCase() === current) : undefined;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cn(styles.chip, styles.channelsMenu)}
        aria-pressed={Boolean(picked)}
        aria-haspopup="menu"
        aria-expanded={anchor != null}
        title={picked ? `Канал: ${picked.name}` : "Выбрать канал"}
        onClick={open}
      >
        <span className={styles.chipName}>{picked ? channelParts(picked.name).name : "Каналы"}</span>
        <span className={styles.chipCount}>{channels.length}</span>
        <RedesignIcon name="chevronDown" className="size-3.5" />
      </button>
      <ArchiveMenu anchor={anchor} label="Каналы" items={items} onClose={close} />
    </>
  );
}
