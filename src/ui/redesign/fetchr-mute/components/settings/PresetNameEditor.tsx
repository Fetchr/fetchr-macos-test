import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import shared from "../../shared.module.css";
import confirm from "../RerunConfirm.module.css";
import styles from "./PresetSelect.module.css";
import { PRESET_NAME_MAX, type PresetNameError } from "../../presets";

interface PresetNameEditorProps {
  initialName: string;
  submitLabel: string;
  /** Ошибка имени — поле остаётся открытым; null — сохранено. */
  onSubmit: (name: string) => PresetNameError | null;
  onDone: () => void;
}

/** Название пресета прямо в колонке: Enter сохраняет, Escape отменяет. */
export function PresetNameEditor({ initialName, submitLabel, onSubmit, onDone }: PresetNameEditorProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<PresetNameError | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const result = onSubmit(name);
    if (result) {
      setError(result);
      inputRef.current?.focus();
      return;
    }
    onDone();
  };

  const errorText =
    error === "empty"
      ? t("fetchr_mute.preset_error_empty")
      : error === "duplicate"
        ? t("fetchr_mute.preset_error_duplicate")
        : t("fetchr_mute.preset_error_too_long", { max: PRESET_NAME_MAX });

  return (
    <div className={styles.editor}>
      <div className={styles.editorRow}>
        <input
          ref={inputRef}
          type="text"
          className={cn(shared.input, styles.editorInput)}
          value={name}
          maxLength={PRESET_NAME_MAX}
          placeholder={t("fetchr_mute.preset_name_placeholder")}
          aria-label={t("fetchr_mute.preset_name_placeholder")}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            // Буквенные хоткеи страницы в поле не срабатывают.
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onDone();
            }
          }}
        />
        <button
          type="button"
          className={shared.iconButton}
          onClick={submit}
          aria-label={submitLabel}
          title={submitLabel}
        >
          <RedesignIcon name="apply" />
        </button>
        <button
          type="button"
          className={shared.iconButton}
          onClick={onDone}
          aria-label={t("fetchr_mute.cancel")}
          title={t("fetchr_mute.cancel")}
        >
          <RedesignIcon name="close" />
        </button>
      </div>
      {error && (
        <p id={errorId} className={styles.editorError} role="alert">
          {errorText}
        </p>
      )}
    </div>
  );
}

interface PresetDeleteConfirmProps {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Удаление пресета: спросить, прежде чем удалить. */
export function PresetDeleteConfirm({ name, onConfirm, onCancel }: PresetDeleteConfirmProps) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const textId = useId();
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div
      className={cn(shared.noticeBox, confirm.confirm)}
      role="alertdialog"
      aria-labelledby={textId}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onCancel();
      }}
    >
      <RedesignIcon name="trash" />
      <span id={textId} className={confirm.text}>
        {t("fetchr_mute.preset_delete_confirm", { name })}
      </span>
      <span className={confirm.actions}>
        <button ref={cancelRef} type="button" className={shared.ghostButton} onClick={onCancel}>
          {t("fetchr_mute.cancel")}
        </button>
        <button type="button" className={cn(shared.ghostButton, shared.ghostDanger)} onClick={onConfirm}>
          {t("fetchr_mute.preset_delete_action")}
        </button>
      </span>
    </div>
  );
}
