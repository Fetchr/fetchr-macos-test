import { useCallback, useEffect, useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import { ipc } from "@/lib/ipc";
import { useFetchrMuteStore } from "@/stores/fetchrMute";

import { formatWordEntry, splitFetchrMuteWords, wordKey } from "../fetchrMuteSettings";
import type { FetchrMuteSettingsState } from "./useFetchrMuteSettings";
import type { RecordEdit } from "./usePendingEdits";

const SENT_SUGGESTED_WORDS_KEY = "sent_suggested_words";

interface WordListsOptions {
  settings: FetchrMuteSettingsState;
  recordEdit: RecordEdit;
  setError: (err: string | null) => void;
}

const withoutWord = (list: string[], word: string) =>
  list.filter((w) => wordKey(w) !== wordKey(word));

interface MergeResult {
  nextTarget: string[];
  nextOther: string[];
  added: string[];
  moved: string[];
  duplicates: string[];
}

/**
 * Добавить слова в один список: нормализация как у бэкенда, без дублей,
 * а слово из другого списка переносится (списки взаимоисключающие).
 */
function mergeWords(target: string[], other: string[], incoming: string[]): MergeResult {
  const targetNorm = new Set(target.map(wordKey));
  const otherNorm = new Set(other.map(wordKey));
  const byKey = new Map<string, string>();
  incoming.forEach((raw) => {
    const entry = formatWordEntry(raw);
    const key = wordKey(entry);
    if (key && !byKey.has(key)) byKey.set(key, entry);
  });
  const unique = Array.from(byKey.entries());
  const added = unique.filter(([key]) => !targetNorm.has(key)).map(([, entry]) => entry);
  const duplicates = unique.filter(([key]) => targetNorm.has(key)).map(([, entry]) => entry);
  const moved = added.filter((w) => otherNorm.has(wordKey(w)));
  const movedSet = new Set(moved.map(wordKey));
  return {
    nextTarget: [...target, ...added],
    nextOther: other.filter((w) => !movedSet.has(wordKey(w))),
    added,
    moved,
    duplicates,
  };
}

/** Списки «Всегда глушить» и «Никогда не глушить»: правки, импорт и отправка новых слов в общий словарь. */
export function useWordLists({
  settings,
  recordEdit,
  setError,
}: WordListsOptions) {
  const { t } = useTranslation();
  const {
    customWordsText,
    setCustomWordsText,
    whitelistWordsText,
    setWhitelistWordsText,
    shareWords,
  } = settings;
  const [machineId, setMachineId] = useState<string>("");

  // Fetch machine ID on mount
  useEffect(() => {
    ipc
      .getMachineId()
      .then(setMachineId)
      .catch((err) => console.error("Failed to load machine ID:", err));
  }, []);

  // Suggest new words to VPS helper
  const suggestNewWords = useCallback(
    (rawWords: string[]) => {
      if (!shareWords || !machineId) return; // requires explicit opt-in
      try {
        const cleanWords = rawWords
          .map((w) =>
            w
              .trim()
              .toLowerCase()
              .replace(/[^a-zа-яё0-9\s-]/g, ""),
          )
          .filter((w) => w.length > 0 && w.length < 50);

        if (cleanWords.length === 0) return;

        const saved = localStorage.getItem(SENT_SUGGESTED_WORDS_KEY);
        const suggestedSet = new Set<string>(saved ? JSON.parse(saved) : []);

        const newWords = cleanWords.filter((w) => !suggestedSet.has(w));
        if (newWords.length === 0) return;

        ipc.suggestMuteWords(newWords, machineId).catch((err) => {
          console.error("Failed to submit suggested words to VPS:", err);
        });

        localStorage.setItem(
          SENT_SUGGESTED_WORDS_KEY,
          JSON.stringify(Array.from(new Set([...suggestedSet, ...newWords]))),
        );
      } catch (e) {
        console.error("Error checking suggested words:", e);
      }
    },
    [shareWords, machineId],
  );

  // Правки словарей копятся неприменёнными: файл пересобирается по «Применить».
  // Quick blacklist / whitelist actions from transcript
  const addWordToBlacklist = useCallback(
    (word: string) => {
      const entry = formatWordEntry(word);
      const norm = wordKey(entry);
      if (!norm) return;

      // Suggest the new blacklisted word to the VPS
      suggestNewWords([entry]);

      recordEdit(() => {
        // Remove from whitelist if present
        const cleanWhitelist = splitFetchrMuteWords(whitelistWordsText).filter(
          (w) => wordKey(w) !== norm,
        );
        setWhitelistWordsText(cleanWhitelist.join(", "));

        // Add to blacklist
        const currentBlacklist = splitFetchrMuteWords(customWordsText);
        const alreadyExists = currentBlacklist.some((w) => wordKey(w) === norm);
        if (!alreadyExists) setCustomWordsText([...currentBlacklist, entry].join(", "));
      });
    },
    [suggestNewWords, whitelistWordsText, customWordsText, recordEdit],
  );

  const removeWordFromBlacklist = useCallback(
    (word: string) => {
      const entry = formatWordEntry(word);
      const norm = wordKey(entry);
      if (!norm) return;

      recordEdit(() => {
        // Remove from blacklist
        const cleanBlacklist = splitFetchrMuteWords(customWordsText).filter(
          (w) => wordKey(w) !== norm,
        );
        setCustomWordsText(cleanBlacklist.join(", "));

        // Add to whitelist
        const currentWhitelist = splitFetchrMuteWords(whitelistWordsText);
        const alreadyExists = currentWhitelist.some((w) => wordKey(w) === norm);
        if (!alreadyExists) setWhitelistWordsText([...currentWhitelist, entry].join(", "));
      });
    },
    [whitelistWordsText, customWordsText, recordEdit],
  );

  /** Добавить слова в список с обратной связью о переносах, дублях и импорте. */
  const addWords = (rawWords: string[], isBlacklist: boolean, fromImport: boolean) => {
    const targetText = isBlacklist ? customWordsText : whitelistWordsText;
    const otherText = isBlacklist ? whitelistWordsText : customWordsText;
    const setTarget = isBlacklist ? setCustomWordsText : setWhitelistWordsText;
    const setOther = isBlacklist ? setWhitelistWordsText : setCustomWordsText;
    const result = mergeWords(
      splitFetchrMuteWords(targetText),
      splitFetchrMuteWords(otherText),
      rawWords,
    );
    const listName = isBlacklist ? t("fetchr_mute.chernyy_spisok") : t("purevoice.whitelist");
    const otherName = isBlacklist ? t("purevoice.whitelist") : t("fetchr_mute.chernyy_spisok");
    const { setNotice } = useFetchrMuteStore.getState();

    if (result.added.length > 0) {
      if (isBlacklist) suggestNewWords(result.added);
      recordEdit(() => {
        setTarget(result.nextTarget.join(", "));
        if (result.moved.length > 0) setOther(result.nextOther.join(", "));
      });
    }

    if (fromImport) {
      setNotice(
        t("fetchr_mute.words_imported", {
          list: listName,
          added: result.added.length,
          moved: result.moved.length,
          duplicates: result.duplicates.length,
          from: otherName,
        }),
      );
    } else if (result.moved.length > 0) {
      setNotice(
        t("fetchr_mute.words_moved", {
          from: otherName,
          to: listName,
          words: result.moved.join(", "),
        }),
      );
    } else if (result.added.length === 0 && result.duplicates.length > 0) {
      setNotice(
        t("fetchr_mute.words_duplicate", { list: listName, words: result.duplicates.join(", ") }),
      );
    }
  };

  const importWords = async (
    event: React.ChangeEvent<HTMLInputElement>,
    isBlacklist: boolean,
  ) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      addWords(splitFetchrMuteWords(text), isBlacklist, true);
    } catch (err) {
      setError(String(err));
    }
  };

  const removeBlacklistWord = (word: string) => {
    const nextList = withoutWord(splitFetchrMuteWords(customWordsText), word);
    recordEdit(() => setCustomWordsText(nextList.join(", ")));
  };

  /** Текст из поля: «а, б; в» или несколько строк — отдельные слова. */
  const addBlacklistWord = (text: string) => {
    addWords(splitFetchrMuteWords(text), true, false);
  };

  const removeWhitelistWord = (word: string) => {
    const nextList = withoutWord(splitFetchrMuteWords(whitelistWordsText), word);
    recordEdit(() => setWhitelistWordsText(nextList.join(", ")));
  };

  const addWhitelistWord = (text: string) => {
    addWords(splitFetchrMuteWords(text), false, false);
  };

  return {
    blacklist: splitFetchrMuteWords(customWordsText),
    whitelist: splitFetchrMuteWords(whitelistWordsText),
    addWordToBlacklist,
    removeWordFromBlacklist,
    addBlacklistWord,
    removeBlacklistWord,
    addWhitelistWord,
    removeWhitelistWord,
    importBlacklist: (event: React.ChangeEvent<HTMLInputElement>) =>
      importWords(event, true),
    importWhitelist: (event: React.ChangeEvent<HTMLInputElement>) =>
      importWords(event, false),
  };
}

export type WordLists = ReturnType<typeof useWordLists>;
