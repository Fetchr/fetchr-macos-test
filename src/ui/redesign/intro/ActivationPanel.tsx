import { forwardRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Send } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useShallow } from "zustand/react/shallow";

import { fetchrBetaBotUrl } from "@/lib/telegram";
import { useBoot } from "@/stores/boot";
import { useUpdater } from "@/stores/updater";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./ActivationPanel.module.css";
import { groupMachineId } from "./bootFormat";

const COPIED_MS = 1400;

/**
 * Табличка активации под поднявшимся логотипом: Machine ID, бот с ключом,
 * поле ключа и строка обновлений. Появление ведёт таймлайн интро по
 * data-activation-part="item".
 */
export const ActivationPanel = forwardRef<HTMLElement>(function ActivationPanel(_props, ref) {
  const { t } = useTranslation();
  const boot = useBoot(
    useShallow((s) => ({
      license: s.license,
      licenseTask: s.licenseTask,
      activationLink: s.activationLink,
      error: s.licenseError,
      busy: s.licenseBusy,
      activate: s.activate,
      recheck: s.recheckLicense,
      startUpdate: s.startUpdate,
      trialEnded: s.trialEnded,
    })),
  );
  const [key, setKey] = useState("");
  const [copied, setCopied] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const machineId = boot.license?.machine_id || boot.activationLink?.machine_id || "";
  const botConfigured = boot.activationLink?.configured ?? false;
  const canRecheck = boot.licenseTask === "failed" || boot.license?.state === "invalid";
  const error = localError ?? boot.error;

  const copyMachineId = async () => {
    if (!machineId) return;
    try {
      await navigator.clipboard.writeText(machineId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_MS);
    } catch (err) {
      setLocalError(t("boot.activation.copy_error", { error: String(err) }));
    }
  };

  const openBot = async () => {
    setLocalError(null);
    try {
      const start = boot.activationLink?.start_parameter || `fetchr_${machineId}`;
      await openUrl(fetchrBetaBotUrl(start));
    } catch (err) {
      setLocalError(t("boot.activation.telegram_error", { error: String(err) }));
    }
  };

  const submit = () => {
    if (!key.trim() || boot.busy) return;
    setLocalError(null);
    void boot.activate(key);
  };

  return (
    <section ref={ref} className={styles.panel} aria-labelledby="activation-title">
      <header className={styles.header} data-activation-part="item">
        <span className={styles.badge} aria-hidden>
          <RedesignIcon name="secure" className="size-5" />
        </span>
        <div className={styles.heading}>
          <h1 id="activation-title" className={styles.title}>
            {t("boot.activation.title")}
          </h1>
          <p className={styles.subtitle}>
            {boot.trialEnded ? t("boot.activation.subtitle_trial") : t("boot.activation.subtitle")}
          </p>
        </div>
      </header>

      <div className={styles.idPlate} data-activation-part="item">
        <div className={styles.idHead}>
          <span className={styles.caption}>{t("boot.activation.machine_id")}</span>
          <button
            className={styles.copy}
            type="button"
            onClick={() => void copyMachineId()}
            disabled={!machineId}
          >
            <RedesignIcon name={copied ? "check" : "copy"} className="size-3.5" />
            {copied ? t("boot.activation.copied") : t("boot.activation.copy")}
          </button>
        </div>
        <div className={styles.idValue} data-empty={!machineId || undefined}>
          {machineId ? groupMachineId(machineId) : t("boot.activation.machine_id_pending")}
        </div>
      </div>

      <ol className={styles.steps}>
        <li className={styles.step} data-activation-part="item">
          <span className={styles.stepIndex} aria-hidden>
            1
          </span>
          <div className={styles.stepBody}>
            <div className={styles.stepTitle}>{t("boot.activation.step_bot")}</div>
            <div className={styles.stepHint}>
              {botConfigured ? t("boot.activation.step_bot_hint") : t("boot.activation.bot_not_configured")}
            </div>
          </div>
          <button
            className={styles.secondary}
            type="button"
            onClick={() => void openBot()}
            disabled={!machineId}
          >
            <Send className="size-3.5" strokeWidth={1.8} aria-hidden />
            {t("boot.activation.open_bot")}
          </button>
        </li>

        <li className={styles.step} data-activation-part="item">
          <span className={styles.stepIndex} aria-hidden>
            2
          </span>
          <div className={styles.stepBody}>
            <label className={styles.stepTitle} htmlFor="activation-key">
              {t("boot.activation.step_key")}
            </label>
            <div className={styles.keyRow}>
              <input
                id="activation-key"
                className={styles.input}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submit();
                }}
                placeholder="FTR1.payload.signature"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                className={styles.primary}
                type="button"
                onClick={submit}
                disabled={boot.busy || !key.trim()}
                aria-busy={boot.busy}
              >
                <RedesignIcon
                  name={boot.busy ? "loading" : "key"}
                  className={boot.busy ? "size-3.5 animate-spin" : "size-3.5"}
                />
                {t("boot.activation.activate")}
              </button>
            </div>
          </div>
        </li>
      </ol>

      {error && (
        <div className={styles.error} role="alert">
          <RedesignIcon name="alert" className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <footer className={styles.footer} data-activation-part="item">
        <UpdateLine onUpdate={boot.startUpdate} />
        {canRecheck && (
          <button
            className={styles.link}
            type="button"
            onClick={() => void boot.recheck()}
            disabled={boot.busy}
          >
            <RedesignIcon name="refresh" className={boot.busy ? "size-3.5 animate-spin" : "size-3.5"} />
            {t("boot.activation.recheck")}
          </button>
        )}
      </footer>
    </section>
  );
});

/** Версия и обновление: ключ может не подойти старой сборке, поэтому кнопка здесь же */
function UpdateLine({ onUpdate }: { onUpdate: () => void }) {
  const { t } = useTranslation();
  const status = useUpdater((s) => s.status);
  if (!status) return <span className={styles.version}>{__APP_VERSION__}</span>;

  if (status.available && status.version) {
    return (
      <span className={styles.updateLine} data-state="available">
        <span className={styles.updateDot} aria-hidden />
        {t("boot.activation.update_available", { version: status.version.replace(/^v/i, "") })}
        {status.installable && (
          <button className={styles.link} type="button" onClick={onUpdate}>
            <RedesignIcon name="install" className="size-3.5" />
            {t("boot.activation.update_now")}
          </button>
        )}
      </span>
    );
  }

  return (
    <span className={styles.updateLine}>
      <span className={styles.updateDot} aria-hidden />
      {status.configured
        ? t("boot.activation.update_current", { version: status.current_version })
        : t("boot.activation.update_unconfigured")}
    </span>
  );
}
