import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../../shared.module.css";
import styles from "./SettingsRail.module.css";
import type { FetchrMuteSettingsState } from "../../hooks/useFetchrMuteSettings";
import type { MutePresets } from "../../hooks/useMutePresets";
import type { SettingsActions } from "../../hooks/useSettingsActions";
import type { WordLists } from "../../hooks/useWordLists";
import type { FetchrMuteStore, FileDetails, SpanGroup } from "../../types";
import { DEFAULT_FETCHR_MUTE_SETTINGS } from "../../fetchrMuteSettings";
import { AdvancedSettings } from "./AdvancedSettings";
import { AudioTrackSection } from "./AudioTrackSection";
import { CoverageSection } from "./CoverageSection";
import { MethodSection } from "./MethodSection";
import { PresetSelect } from "./PresetSelect";
import { ResultSummary } from "./ResultSummary";
import { SaveAsSection } from "./SaveAsSection";
import { TogglesSection } from "./TogglesSection";
import { WordListsSection } from "./WordListsSection";

interface SettingsRailProps {
  store: FetchrMuteStore;
  settings: FetchrMuteSettingsState;
  actions: SettingsActions;
  wordLists: WordLists;
  presets: MutePresets;
  fileDetails: FileDetails | null;
  /** Итог проверки — только на экране проверки. */
  summary: { mutedCount: number; uncertainCount: number } | null;
  spanGroups: SpanGroup[];
  onShowGroup: (group: SpanGroup) => void;
}

/** Сколько редких настроек отличается от значений по умолчанию. */
function countAdvancedChanges(
  settings: FetchrMuteSettingsState,
  store: FetchrMuteStore,
  trackNeedsRerun: boolean,
): number {
  const defaultTrack = store.audioTracks.find((track) => track.is_default);
  const trackChanged =
    trackNeedsRerun ||
    (store.audioTracks.length > 1 &&
      defaultTrack !== undefined &&
      defaultTrack.index !== store.audioTrackIndex);
  return [
    settings.coveragePercent !== DEFAULT_FETCHR_MUTE_SETTINGS.coverage_percent,
    settings.onlyCustomWords,
    settings.shareWords,
    trackChanged,
  ].filter(Boolean).length;
}

interface AdvancedWarningsProps {
  customWordsMissing: boolean;
  trackNeedsRerun: boolean;
  onRerun: () => void;
}

// Предупреждения из «Дополнительно» не прячутся вместе с блоком.
function AdvancedWarnings({ customWordsMissing, trackNeedsRerun, onRerun }: AdvancedWarningsProps) {
  const { t } = useTranslation();
  if (!customWordsMissing && !trackNeedsRerun) return null;
  return (
    <>
      {customWordsMissing && (
        <p className={styles.toggleWarning} role="status">
          {t("fetchr_mute.only_custom_words_empty")}
        </p>
      )}
      {trackNeedsRerun && (
        <div className={styles.trackRerun}>
          <p className={shared.sidebarHint}>{t("fetchr_mute.track_changed_hint")}</p>
          <button type="button" className={shared.secondaryButton} onClick={onRerun}>
            <RedesignIcon name="refresh" />
            {t("fetchr_mute.reanalyze")}
          </button>
        </div>
      )}
    </>
  );
}

/** Правая колонка: пресет, итог, «что глушить» и способ; редкое — в «Дополнительно». */
export function SettingsRail({
  store,
  settings,
  actions,
  wordLists,
  presets,
  fileDetails,
  summary,
  spanGroups,
  onShowGroup,
}: SettingsRailProps) {
  const { t } = useTranslation();
  const { processing, outputPath, audioTracks } = store;
  const customWordsMissing = settings.onlyCustomWords && wordLists.blacklist.length === 0;
  const modifiedCount = countAdvancedChanges(settings, store, actions.trackNeedsRerun);
  // inert вместо pointer-events: блокирует и клавиатуру, и скринридер.
  // В React 18 атрибута нет в типах — ставим его на DOM напрямую.
  const lockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    lockRef.current?.toggleAttribute("inert", processing);
  }, [processing]);
  return (
    <aside className={shared.sidebar} aria-busy={processing || undefined}>
      {processing && (
        <p className={styles.lockReason} role="status">
          <RedesignIcon name="info" />
          {t("fetchr_mute.settings_locked_processing")}
        </p>
      )}
      <div
        ref={lockRef}
        className={cn(styles.lockable, processing && styles.sidebarDisabled)}
        aria-disabled={processing || undefined}
      >
        <section className={shared.sidebarSection}>
          <h2 className={shared.sidebarTitle}>{t("fetchr_mute.preset_title")}</h2>
          <PresetSelect presets={presets} />
        </section>
        {summary && (
          <ResultSummary
            mutedCount={summary.mutedCount}
            uncertainCount={summary.uncertainCount}
            spanGroups={spanGroups}
            onShowGroup={onShowGroup}
          />
        )}
        <WordListsSection
          blacklist={wordLists.blacklist}
          whitelist={wordLists.whitelist}
          onAddBlacklist={wordLists.addBlacklistWord}
          onRemoveBlacklist={wordLists.removeBlacklistWord}
          onImportBlacklist={wordLists.importBlacklist}
          onAddWhitelist={wordLists.addWhitelistWord}
          onRemoveWhitelist={wordLists.removeWhitelistWord}
          onImportWhitelist={wordLists.importWhitelist}
        />
        <MethodSection
          censorMethod={settings.censorMethod}
          customSoundPath={settings.customSoundPath}
          onSelect={actions.selectMethod}
          onChooseCustomSound={actions.chooseCustomSound}
        />
        <AdvancedSettings
          modifiedCount={modifiedCount}
          warnings={
            <AdvancedWarnings
              customWordsMissing={customWordsMissing}
              trackNeedsRerun={actions.trackNeedsRerun}
              onRerun={actions.rerun}
            />
          }
        >
          <CoverageSection
            coveragePercent={settings.coveragePercent}
            onSelect={actions.selectCoverage}
          />
          <TogglesSection
            onlyCustomWords={settings.onlyCustomWords}
            onOnlyCustomWordsChange={actions.toggleOnlyCustomWords}
            customWordsEmpty={wordLists.blacklist.length === 0}
            shareWords={settings.shareWords}
            onShareWordsChange={settings.updateShareWords}
          />
          {audioTracks.length > 0 && (
            <AudioTrackSection
              audioTracks={audioTracks}
              audioTrackIndex={store.audioTrackIndex}
              onSelect={actions.selectAudioTrack}
              needsRerun={actions.trackNeedsRerun}
              onRerun={actions.rerun}
            />
          )}
        </AdvancedSettings>
        <SaveAsSection
          outputDir={store.outputDir}
          outputName={store.outputName}
          sourceDir={fileDetails?.parent}
          hasResult={Boolean(outputPath)}
          currentOutputPath={outputPath}
          recensoring={store.recensoring}
          onChooseDir={actions.chooseOutputDir}
          onResetDir={actions.resetOutputDir}
          onNameChange={store.setOutputName}
          onSaveCopy={actions.saveToTarget}
        />
      </div>
    </aside>
  );
}
