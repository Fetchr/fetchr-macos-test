import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { useVpsRecorderStore } from "@/stores/vpsRecorder";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import { ConfirmModal } from "./ConfirmModal";
import { fmtQuota } from "./format";
import { plansUrl } from "./plans";
import { activePlan, daysLeft, fmtDays, fmtPaidUntil } from "./subscription";
import styles from "./HostingChoice.module.css";

/** "Сервер" tab for the archive bought on fetchr.fun: nothing to configure,
 *  only the plan, its renewal and a way to detach this computer. */
export function ManagedServerPanel() {
  const status = useVpsRecorderStore((s) => s.status);
  const forget = useVpsRecorderStore((s) => s.forgetManaged);
  const plan = activePlan(status);
  const left = daysLeft(plan?.paidUntil ?? null);
  const [confirmForget, setConfirmForget] = useState(false);

  return (
    <div className={styles.handoff}>
      <div className={styles.handoffText}>
        <strong>{plan ? `Тариф «${plan.plan.name}» · ${fmtQuota(plan.quota)}` : "Сервер Fetchr"}</strong>
        <span>
          {plan?.paidUntil
            ? left
              ? `Оплачен до ${fmtPaidUntil(plan.paidUntil)}, осталось ${fmtDays(left)}.`
              : "Тариф закончился: записи доступны, новые эфиры не пишутся."
            : "Сервер держим мы — настраивать ничего не нужно."}
        </span>
      </div>
      <button type="button" className={styles.handoffButton} onClick={() => void openUrl(plansUrl())}>
        <RedesignIcon name="external" />
        Продлить или сменить тариф
      </button>
      <button type="button" className={styles.handoffButton} onClick={() => setConfirmForget(true)}>
        Отключить от этого компьютера
      </button>
      <ConfirmModal
        open={confirmForget}
        title="Отключить архив Fetchr от этого компьютера?"
        confirmLabel="Отключить"
        onCancel={() => setConfirmForget(false)}
        onConfirm={() => {
          setConfirmForget(false);
          void forget();
        }}
      >
        Записи, клипы и тариф останутся на сервере Fetchr — пропадёт только доступ с этого
        компьютера. Вернуть его можно кнопкой «У меня уже есть тариф» на этой странице.
      </ConfirmModal>
    </div>
  );
}
