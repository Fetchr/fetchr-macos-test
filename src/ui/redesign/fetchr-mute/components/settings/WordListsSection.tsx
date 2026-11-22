import { useRef } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../../shared.module.css";
import styles from "./SettingsRail.module.css";
import { WordTagInput } from "./WordTagInput";

type ImportHandler = (event: React.ChangeEvent<HTMLInputElement>) => void;

interface WordListsSectionProps {
  blacklist: string[];
  whitelist: string[];
  onAddBlacklist: (word: string) => void;
  onRemoveBlacklist: (word: string) => void;
  onImportBlacklist: ImportHandler;
  onAddWhitelist: (word: string) => void;
  onRemoveWhitelist: (word: string) => void;
  onImportWhitelist: ImportHandler;
}

/** «Всегда глушить» и «Никогда не глушить»: теги и импорт из файла. */
export function WordListsSection({
  blacklist,
  whitelist,
  onAddBlacklist,
  onRemoveBlacklist,
  onImportBlacklist,
  onAddWhitelist,
  onRemoveWhitelist,
  onImportWhitelist,
}: WordListsSectionProps) {
  const { t } = useTranslation();
  return (
    <section className={shared.sidebarSection}>
      <h2 className={shared.sidebarTitle}>
        {t("fetchr_mute.chernyy_spisok")}
        <span className={shared.count}>{blacklist.length}</span>
      </h2>
      <WordTagInput
        words={blacklist}
        onRemove={onRemoveBlacklist}
        onAdd={onAddBlacklist}
        tone="black"
      />
      <ImportWordsButton onImport={onImportBlacklist} />

      <h2 className={cn(shared.sidebarTitle, styles.sidebarTitleSpaced)}>
        {t("purevoice.whitelist")}
        <span className={shared.count}>{whitelist.length}</span>
      </h2>
      <WordTagInput
        words={whitelist}
        onRemove={onRemoveWhitelist}
        onAdd={onAddWhitelist}
        tone="white"
      />
      <ImportWordsButton onImport={onImportWhitelist} />
    </section>
  );
}

// Кнопка-ссылка и скрытый выбор файла со словами (.txt, .csv).
function ImportWordsButton({ onImport }: { onImport: ImportHandler }) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        className={shared.linkButton}
        type="button"
        onClick={() => inputRef.current?.click()}
      >
        <RedesignIcon name="download" />
        {t("purevoice.import_words")}
      </button>
      <input
        ref={inputRef}
        className={shared.hiddenInput}
        type="file"
        accept=".txt,.csv,text/plain,text/csv"
        onChange={onImport}
      />
    </>
  );
}
