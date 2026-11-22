import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import type { VpsClipMeta, VpsRecordingMeta } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";

import styles from "./ArchiveCommandBar.module.css";
import { SEARCH_GROUPS, searchArchive, type SearchHit, type SearchHitKind } from "./archiveSearchModel";

const HIT_ICON: Record<SearchHitKind, RedesignIconName> = {
  recording: "video",
  clip: "media",
  marker: "bookmark",
};

interface ArchiveSearchProps {
  query: string;
  onQuery: (value: string) => void;
  recordings: readonly VpsRecordingMeta[];
  clips: readonly VpsClipMeta[];
  onPick: (hit: SearchHit) => void;
}

/**
 * Ctrl+K на странице архива сначала ведёт сюда; второе нажатие, когда фокус
 * уже в поиске, уходит общей палитре приложения (app-layout слушает window
 * в фазе всплытия и пропускает событие с defaultPrevented).
 */
function useArchiveHotkey(inputRef: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      const input = inputRef.current;
      if (!input || document.activeElement === input) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inputRef]);
}

/** Поиск по записям, клипам и меткам с выпадающим списком. Текст же фильтрует библиотеку. */
export function ArchiveSearch({ query, onQuery, recordings, clips, onPick }: ArchiveSearchProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const hits = useMemo(() => searchArchive(query, recordings, clips), [query, recordings, clips]);
  const showList = open && query.trim().length > 0;
  useArchiveHotkey(inputRef);

  useEffect(() => setActive(0), [query]);

  const choose = (hit: SearchHit) => {
    setOpen(false);
    onPick(hit);
    inputRef.current?.blur();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (hits.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      const hit = showList ? hits[active] : undefined;
      if (hit) {
        event.preventDefault();
        choose(hit);
      } else setOpen(false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (showList) setOpen(false);
      else if (query) onQuery("");
      else inputRef.current?.blur();
    }
  };

  const activeHit = showList ? hits[active] : undefined;

  return (
    <div className={styles.searchBox}>
      <label className={styles.search}>
        <RedesignIcon name="finder" className="size-3.5" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            onQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder="Записи, клипы, метки"
          aria-label="Поиск по архиву"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeHit ? `${listId}-${activeHit.id}` : undefined}
          spellCheck={false}
        />
        {query ? (
          <button type="button" className={styles.searchClear} onClick={() => onQuery("")} aria-label="Очистить поиск">
            <RedesignIcon name="close" className="size-3" />
          </button>
        ) : (
          <kbd className={styles.searchKbd} aria-hidden>
            Ctrl K
          </kbd>
        )}
      </label>
      {showList && <SearchResults id={listId} hits={hits} active={active} onHover={setActive} onChoose={choose} />}
    </div>
  );
}

function SearchResults({
  id,
  hits,
  active,
  onHover,
  onChoose,
}: {
  id: string;
  hits: SearchHit[];
  active: number;
  onHover: (index: number) => void;
  onChoose: (hit: SearchHit) => void;
}) {
  return (
    <ul id={id} className={styles.results} role="listbox" aria-label="Найдено в архиве">
      {hits.length === 0 && (
        <li className={styles.resultsEmpty} role="presentation">
          Ничего не нашлось
        </li>
      )}
      {SEARCH_GROUPS.map((group) => {
        const items = hits.filter((hit) => hit.kind === group.kind);
        if (items.length === 0) return null;
        return [
          <li key={group.kind} className={styles.resultsGroup} role="presentation">
            {group.label}
          </li>,
          ...items.map((hit) => {
            const index = hits.indexOf(hit);
            return (
              <li
                key={hit.id}
                id={`${id}-${hit.id}`}
                role="option"
                aria-selected={index === active}
                className={cn(styles.result, index === active && styles.resultActive)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHover(index)}
                onClick={() => onChoose(hit)}
              >
                <RedesignIcon name={HIT_ICON[hit.kind]} className={styles.resultIcon} />
                <span className={styles.resultText}>
                  <span className={styles.resultTitle}>{hit.title}</span>
                  <span className={styles.resultMeta}>{hit.meta}</span>
                </span>
              </li>
            );
          }),
        ];
      })}
    </ul>
  );
}
