import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";

import shared from "../../shared.module.css";
import menu from "../Menu.module.css";
import styles from "./PresetSelect.module.css";
import { useMenu, type MenuCloseReason } from "../../hooks/useMenu";
import type { MutePresets } from "../../hooks/useMutePresets";
import { PresetDeleteConfirm, PresetNameEditor } from "./PresetNameEditor";

interface PresetSelectProps {
  presets: MutePresets;
  disabled?: boolean;
}

type Editing = "save" | "rename" | null;

interface ActionItem {
  id: string;
  label: string;
  icon: RedesignIconName;
  onSelect: () => void;
  danger?: boolean;
}

/** Кнопка-меню пресета: выбор, «Сохранить как пресет…», обновление, переименование, удаление. */
export function PresetSelect({ presets, disabled }: PresetSelectProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const target = presets.userTarget;

  const close = (reason: MenuCloseReason) => {
    setOpen(false);
    if (reason !== "outside") buttonRef.current?.focus();
  };
  const { onKeyDown } = useMenu({ open, menuRef, anchorRef: buttonRef, onClose: close });

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  const startEditing = (mode: Editing) => {
    setConfirmDelete(false);
    setEditing(mode);
  };

  const actions: ActionItem[] = [
    { id: "save", label: t("fetchr_mute.preset_save_as"), icon: "save", onSelect: () => startEditing("save") },
    ...(presets.canUpdate && target
      ? [{
          id: "update",
          label: t("fetchr_mute.preset_update", { name: target.name }),
          icon: "refresh" as const,
          onSelect: presets.updateTarget,
        }]
      : []),
    ...(target
      ? [
          { id: "rename", label: t("fetchr_mute.preset_rename"), icon: "pencil" as const, onSelect: () => startEditing("rename") },
          {
            id: "delete",
            label: t("fetchr_mute.preset_delete", { name: target.name }),
            icon: "trash" as const,
            danger: true,
            onSelect: () => {
              setEditing(null);
              setConfirmDelete(true);
            },
          },
        ]
      : []),
  ];

  const finishEditing = () => {
    setEditing(null);
    buttonRef.current?.focus();
  };

  return (
    <div className={styles.presetSelect}>
      <div className={styles.anchor}>
        <button
          ref={buttonRef}
          type="button"
          className={cn(shared.secondaryButton, styles.trigger)}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
        >
          <RedesignIcon name="preset" />
          <span className={styles.triggerLabel}>{presets.label}</span>
          <RedesignIcon name="chevronDown" />
        </button>
        {open && (
          <div
            ref={menuRef}
            role="menu"
            aria-label={t("fetchr_mute.preset_menu_aria")}
            className={cn(menu.menu, styles.presetMenu)}
            onKeyDown={onKeyDown}
          >
            {presets.presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="menuitemradio"
                aria-checked={preset.id === presets.activeId}
                tabIndex={-1}
                className={menu.item}
                onClick={() => run(() => presets.apply(preset.id))}
              >
                <span className={styles.checkSlot} aria-hidden="true">
                  {preset.id === presets.activeId && <RedesignIcon name="check" />}
                </span>
                <span className={menu.itemLabel}>{preset.name}</span>
              </button>
            ))}
            <div className={menu.separator} role="separator" />
            {actions.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={cn(menu.item, item.danger && menu.itemDanger)}
                onClick={() => run(item.onSelect)}
              >
                <RedesignIcon name={item.icon} />
                <span className={menu.itemLabel}>{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {editing && (
        <PresetNameEditor
          initialName={editing === "rename" ? (target?.name ?? "") : ""}
          submitLabel={editing === "rename" ? t("fetchr_mute.preset_rename_action") : t("fetchr_mute.preset_name_save")}
          onSubmit={(name) => (editing === "rename" ? presets.renameTarget(name) : presets.saveAs(name))}
          onDone={finishEditing}
        />
      )}
      {confirmDelete && target && (
        <PresetDeleteConfirm
          name={target.name}
          onConfirm={() => {
            presets.deleteTarget();
            setConfirmDelete(false);
            buttonRef.current?.focus();
          }}
          onCancel={() => {
            setConfirmDelete(false);
            buttonRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
