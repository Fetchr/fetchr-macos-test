import { useTranslation } from "react-i18next";
import { useWorkflowPresets } from "@/stores/workflowPresets";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { fetchrThemeClassName } from "@/ui/redesign/theme";

import styles from "./WorkspaceBuilderPage.module.css";

export function WorkspaceBuilderPage() {
  const { t } = useTranslation();
  const m3u8Presets = useWorkflowPresets((state) => state.m3u8Presets);
  const chatPresets = useWorkflowPresets((state) => state.chatPresets);
  const sponsorPresets = useWorkflowPresets((state) => state.sponsorPresets);
  const createM3u8Preset = useWorkflowPresets((state) => state.createM3u8Preset);
  const renameM3u8Preset = useWorkflowPresets((state) => state.renameM3u8Preset);
  const updateM3u8Preset = useWorkflowPresets((state) => state.updateM3u8Preset);
  const createChatPreset = useWorkflowPresets((state) => state.createChatPreset);
  const renameChatPreset = useWorkflowPresets((state) => state.renameChatPreset);
  const createSponsorPreset = useWorkflowPresets((state) => state.createSponsorPreset);
  const renameSponsorPreset = useWorkflowPresets((state) => state.renameSponsorPreset);

  return (
    <div className={`${fetchrThemeClassName} ${styles.page}`}>
      <header className={styles.workspaceToolbar}>
        <div>
          <h1>{t("workspace.presets_title", "Пресеты быстрого скачивания")}</h1>
          <p>{t("workspace.presets_desc", "Workspace больше не является конструктором блоков. Здесь хранятся быстрые пресеты для повторяющихся стримеров, чата и блюра.")}</p>
        </div>
      </header>

      <main className={styles.presetManagerGrid}>
        <section className={styles.presetManagerCard}>
          <div className={styles.presetManagerHeader}>
            <div>
              <h2>M3U8 Finder</h2>
              <p>{t("workspace.presets_m3u8_desc", "Эти пресеты отображаются под M3U8 Finder в левой панели.")}</p>
            </div>
            <button className={styles.presetManagerButton} type="button" onClick={() => createM3u8Preset(null)}>
              <RedesignIcon name="add" />
              {t("workspace.presets_create", "Создать")}
            </button>
          </div>
          <div className={styles.presetManagerList}>
            {m3u8Presets.length === 0 ? <div className={styles.presetManagerEmpty}>{t("workspace.presets_empty_m3u8", "Создайте пресет через плюс у M3U8 Finder.")}</div> : null}
            {m3u8Presets.map((preset) => (
              <div className={styles.presetManagerRow} key={preset.id}>
                <input value={preset.name} onChange={(event) => renameM3u8Preset(preset.id, event.currentTarget.value)} />
                <input value={preset.streamer} placeholder={t("workspace.presets_streamer_placeholder", "ник стримера")} onChange={(event) => updateM3u8Preset(preset.id, { streamer: event.currentTarget.value })} />
              </div>
            ))}
          </div>
        </section>

        <section className={styles.presetManagerCard}>
          <div className={styles.presetManagerHeader}>
            <div>
              <h2>{t("nav.chat_render", "Рендер чата")}</h2>
              <p>{t("workspace.presets_chat_desc", "Пресеты выбираются внутри раздела рендера чата и не добавляются в левую панель.")}</p>
            </div>
            <button className={styles.presetManagerButton} type="button" onClick={() => createChatPreset(chatPresets[0]?.id ?? null)}>
              <RedesignIcon name="copy" />
              {t("workspace.presets_copy", "Копия")}
            </button>
          </div>
          <div className={styles.presetManagerList}>
            {chatPresets.map((preset) => (
              <div className={styles.presetManagerRow} key={preset.id}>
                <input value={preset.name} onChange={(event) => renameChatPreset(preset.id, event.currentTarget.value)} />
                <span>{preset.overlay.font_family ?? "system"} · {preset.overlay.font_size ?? 24}px</span>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.presetManagerCard}>
          <div className={styles.presetManagerHeader}>
            <div>
              <h2>{t("nav.sponsor_blur", "Блюр спонсоров")}</h2>
              <p>{t("workspace.presets_blur_desc", "Пресеты выбираются над экраном блюра и при добавлении задачи.")}</p>
            </div>
            <button className={styles.presetManagerButton} type="button" onClick={() => createSponsorPreset(sponsorPresets[0]?.id ?? null)}>
              <RedesignIcon name="copy" />
              {t("workspace.presets_copy", "Копия")}
            </button>
          </div>
          <div className={styles.presetManagerList}>
            {sponsorPresets.map((preset) => (
              <div className={styles.presetManagerRow} key={preset.id}>
                <input value={preset.name} onChange={(event) => renameSponsorPreset(preset.id, event.currentTarget.value)} />
                <span>{t("workspace.presets_zones_count", { count: preset.zones.length, defaultValue: "{{count}} зон" })}</span>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
