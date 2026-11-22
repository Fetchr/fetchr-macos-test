import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import styles from "./select.module.css";

/*
 * Замена нативному <select>.
 *
 * Выпадающий список нативного <select> в WebView2 рисует сама Windows: при
 * светлой теме ОС он белый, а текст наследует светлый цвет приложения — пункты
 * не видно. color-scheme это чинит не во всех сборках WebView2. Здесь попап
 * рисуется приложением, поэтому выглядит одинаково в светлой и тёмной Windows.
 *
 * API повторяет <select>: дети — <option>/<optgroup>, поэтому замена в разметке
 * сводится к смене тега и onChange → onValueChange.
 */

export interface SelectItem {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
  group?: string;
  style?: CSSProperties;
}

export interface SelectProps {
  value: string | number;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  /** Поле поиска в попапе. По умолчанию включается при длинном списке. */
  searchable?: boolean;
  searchPlaceholder?: string;
  title?: string;
  "aria-label"?: string;
}

const AUTO_SEARCH_THRESHOLD = 10;
const POPUP_MAX_HEIGHT = 320;
const POPUP_GAP = 4;

export function Select({
  value,
  onValueChange,
  children,
  className,
  disabled = false,
  searchable,
  searchPlaceholder = "Поиск…",
  title,
  "aria-label": ariaLabel,
}: SelectProps) {
  const items = useMemo(() => collectItems(children), [children]);
  const current = String(value);
  const selected = items.find((item) => item.value === current);
  const withSearch = searchable ?? items.length > AUTO_SEARCH_THRESHOLD;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  const visible = useMemo(() => filterItems(items, query), [items, query]);

  const openPopup = useCallback(() => {
    if (disabled) return;
    setQuery("");
    setOpen(true);
  }, [disabled]);

  const closePopup = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (item: SelectItem | undefined) => {
      if (!item || item.disabled) return;
      closePopup(true);
      if (item.value !== current) onValueChange(item.value);
    },
    [closePopup, current, onValueChange],
  );

  // При открытии и при смене фильтра подсвечиваем выбранный пункт или первый доступный
  useEffect(() => {
    if (!open) return;
    const selectedIndex = visible.findIndex((item) => item.value === current);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : nextEnabled(visible, -1, 1));
  }, [open, visible, current]);

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      openPopup();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        className={`${styles.trigger} ${className ?? ""}`}
        onClick={() => (open ? closePopup(false) : openPopup())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={styles.triggerLabel} style={selected?.style}>
          {selected?.label ?? ""}
        </span>
        <svg className={styles.chevron} viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open &&
        createPortal(
          <SelectPopup
            anchor={triggerRef}
            listboxId={listboxId}
            items={visible}
            current={current}
            activeIndex={activeIndex}
            query={query}
            withSearch={withSearch}
            searchPlaceholder={searchPlaceholder}
            onQueryChange={setQuery}
            onActiveChange={setActiveIndex}
            onCommit={commit}
            onClose={closePopup}
          />,
          document.body,
        )}
    </>
  );
}

interface SelectPopupProps {
  anchor: RefObject<HTMLButtonElement | null>;
  listboxId: string;
  items: SelectItem[];
  current: string;
  activeIndex: number;
  query: string;
  withSearch: boolean;
  searchPlaceholder: string;
  onQueryChange: (value: string) => void;
  onActiveChange: (index: number) => void;
  onCommit: (item: SelectItem | undefined) => void;
  onClose: (refocus: boolean) => void;
}

function SelectPopup({
  anchor,
  listboxId,
  items,
  current,
  activeIndex,
  query,
  withSearch,
  searchPlaceholder,
  onQueryChange,
  onActiveChange,
  onCommit,
  onClose,
}: SelectPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    const place = () => {
      const trigger = anchor.current;
      if (!trigger) return;
      setPosition(computePosition(trigger.getBoundingClientRect()));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    (withSearch ? searchRef.current : listRef.current)?.focus({ preventScroll: true });
  }, [withSearch]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popupRef.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchor, onClose]);

  useEffect(() => {
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    option?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Модалки закрываются по Escape на document — не отдаём им событие
    event.stopPropagation();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        onActiveChange(nextEnabled(items, activeIndex, 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        onActiveChange(nextEnabled(items, activeIndex, -1));
        return;
      case "Home":
        if (withSearch) return;
        event.preventDefault();
        onActiveChange(nextEnabled(items, -1, 1));
        return;
      case "End":
        if (withSearch) return;
        event.preventDefault();
        onActiveChange(nextEnabled(items, items.length, -1));
        return;
      case "Enter":
        event.preventDefault();
        onCommit(items[activeIndex]);
        return;
      case "Escape":
        event.preventDefault();
        onClose(true);
        return;
      case "Tab":
        onClose(true);
        return;
      default:
        if (!withSearch && event.key.length === 1) jumpByTypeahead(event.key);
    }
  };

  const jumpByTypeahead = (char: string) => {
    const now = Date.now();
    const text = now - typeahead.current.at < 700 ? typeahead.current.text + char : char;
    typeahead.current = { text, at: now };
    const needle = text.toLocaleLowerCase();
    const index = items.findIndex((item) => !item.disabled && item.text.toLocaleLowerCase().startsWith(needle));
    if (index >= 0) onActiveChange(index);
  };

  return (
    <div ref={popupRef} className={styles.popup} style={position} onKeyDown={onKeyDown}>
      {withSearch && (
        <input
          ref={searchRef}
          className={styles.search}
          value={query}
          placeholder={searchPlaceholder}
          aria-controls={listboxId}
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      )}
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        tabIndex={-1}
        className={styles.list}
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
      >
        {items.length === 0 && <div className={styles.empty}>Ничего не найдено</div>}
        {items.map((item, index) => (
          <SelectOptionRow
            key={`${item.group ?? ""}:${item.value}`}
            id={`${listboxId}-${index}`}
            item={item}
            index={index}
            groupStart={item.group !== undefined && item.group !== items[index - 1]?.group}
            selected={item.value === current}
            active={index === activeIndex}
            onHover={onActiveChange}
            onCommit={onCommit}
          />
        ))}
      </div>
    </div>
  );
}

function SelectOptionRow({
  id,
  item,
  index,
  groupStart,
  selected,
  active,
  onHover,
  onCommit,
}: {
  id: string;
  item: SelectItem;
  index: number;
  groupStart: boolean;
  selected: boolean;
  active: boolean;
  onHover: (index: number) => void;
  onCommit: (item: SelectItem) => void;
}) {
  return (
    <>
      {groupStart && <div className={styles.group}>{item.group}</div>}
      <div
        id={id}
        role="option"
        data-index={index}
        aria-selected={selected}
        aria-disabled={item.disabled || undefined}
        data-active={active || undefined}
        className={styles.option}
        style={item.style}
        onPointerMove={() => !item.disabled && !active && onHover(index)}
        onClick={() => onCommit(item)}
      >
        <span className={styles.optionLabel}>{item.label}</span>
        {selected && (
          <svg className={styles.check} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
    </>
  );
}

function computePosition(rect: DOMRect): CSSProperties {
  const below = window.innerHeight - rect.bottom - POPUP_GAP - 8;
  const above = rect.top - POPUP_GAP - 8;
  const openUp = below < 200 && above > below;
  const maxHeight = Math.max(120, Math.min(POPUP_MAX_HEIGHT, openUp ? above : below));
  const minWidth = Math.max(rect.width, 160);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - minWidth - 8));
  return openUp
    ? { left, minWidth, maxHeight, bottom: window.innerHeight - rect.top + POPUP_GAP }
    : { left, minWidth, maxHeight, top: rect.bottom + POPUP_GAP };
}

function nextEnabled(items: SelectItem[], from: number, step: 1 | -1): number {
  for (let index = from + step; index >= 0 && index < items.length; index += step) {
    if (!items[index].disabled) return index;
  }
  return from >= 0 && from < items.length ? from : -1;
}

function filterItems(items: SelectItem[], query: string): SelectItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return items;
  return items.filter((item) => item.text.toLocaleLowerCase().includes(needle));
}

function collectItems(children: ReactNode, group?: string): SelectItem[] {
  return Children.toArray(children).flatMap((child): SelectItem[] => {
    if (!isValidElement(child)) return [];
    const element = child as ReactElement<Record<string, unknown>>;
    const props = element.props;
    if (element.type === "optgroup") {
      return collectItems(props.children as ReactNode, String(props.label ?? ""));
    }
    if (element.type === "option") {
      const label = props.children as ReactNode;
      const text = nodeText(label);
      return [
        {
          value: String(props.value ?? text),
          label,
          text,
          disabled: Boolean(props.disabled),
          group,
          style: props.style as CSSProperties | undefined,
        },
      ];
    }
    return collectItems(props.children as ReactNode, group);
  });
}

function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return "";
}
