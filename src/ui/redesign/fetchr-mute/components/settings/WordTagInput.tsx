import { useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { LIST_INPUT_ATTR } from "../../hooks/useEditShortcuts";
import styles from "./WordTagInput.module.css";

interface WordTagInputProps {
  words: string[];
  onRemove: (word: string) => void;
  /** Текст поля по Enter, запятой или «;» (уход фокуса текст не коммитит); разбивку на слова делает получатель. */
  onAdd: (word: string) => void;
  tone: "black" | "white";
}

/** Список слов тегами с полем добавления. */
export function WordTagInput({ words, onRemove, onAdd, tone }: WordTagInputProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const hasDraft = draft.trim() !== "";

  const commit = () => {
    if (!hasDraft) return;
    onAdd(draft);
    setDraft("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      e.preventDefault();
      commit();
      return;
    }
    // Ctrl+S применяет правки (обработчик на window, после этого): сначала
    // добавить недописанное слово, иначе оно не попадёт в применённый набор.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyS") commit();
  };

  return (
    <div className={cn(styles.tags, tone === "white" && styles.tagsWhite)}>
      {words.map((word, idx) => (
        <span key={`${word}-${idx}`} className={styles.tag}>
          <span className={styles.tagText}>{word}</span>
          <button
            type="button"
            onClick={() => onRemove(word)}
            className={styles.tagRemove}
            aria-label={`${t("fetchr_mute.udalit_slovo")} ${word}`}
            title={t("fetchr_mute.udalit_slovo")}
          >
            <RedesignIcon name="close" />
          </button>
        </span>
      ))}
      <input
        type="text"
        placeholder={t("fetchr_mute.dobavit")}
        className={styles.tagInput}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        {...{ [LIST_INPUT_ATTR]: "" }}
        aria-label={
          tone === "black"
            ? t("fetchr_mute.add_word_blacklist")
            : t("fetchr_mute.add_word_whitelist")
        }
      />
      {hasDraft && (
        <button
          type="button"
          className={styles.tagHint}
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
        >
          {t("fetchr_mute.word_input_enter_hint")}
        </button>
      )}
    </div>
  );
}
