import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { useVpsRecorderStore } from "@/stores/vpsRecorder";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import compact from "./ArchiveCompact.module.css";
import { ConfirmModal } from "./ConfirmModal";
import { fmtBytes, fmtHours, fmtQuota } from "./format";
import { hoursFor, plansUrl } from "./plans";
import { activePlan, daysLeft, fmtPaidUntil } from "./subscription";

/** Своя VPS или сервер Fetchr, если подключены оба. */
export function SourceSwitch({ className }: { className?: string }) {
  const config = useVpsRecorderStore((s) => s.config);
  const managed = useVpsRecorderStore((s) => s.managed);
  const selectSource = useVpsRecorderStore((s) => s.selectSource);
  if (!config.host || !managed.available) return null;
  return (
    <div className={cn(compact.segment, className)} role="group" aria-label="Какой сервер показывать">
      {[
        { id: false, label: "Своя VPS" },
        { id: true, label: "Fetchr" },
      ].map((item) => (
        <button
          key={item.label}
          type="button"
          className={compact.segmentItem}
          aria-pressed={managed.active === item.id}
          onClick={() => {
            if (managed.active !== item.id) void selectSource(item.id);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Сервер в командной строке: связь, имя и заполнение. Подробности — в разделе «Сервер». */
export function ServerChip({ online, active, onOpen }: { online: boolean; active: boolean; onOpen: () => void }) {
  const config = useVpsRecorderStore((s) => s.config);
  const managed = useVpsRecorderStore((s) => s.managed);
  const storage = useStorageInfo();
  const name = managed.active ? "Сервер Fetchr" : config.host || "Сервер";
  const percent = storage ? Math.round(storage.ratio * 100) : null;
  const title = [
    `${name} · ${online ? "на связи" : "нет связи"}`,
    storage ? `Место: ${storage.usedText}` : null,
    storage?.forecast ?? null,
    "Открыть настройки сервера",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <button type="button" className={compact.serverChip} aria-pressed={active} onClick={onOpen} title={title} aria-label={title}>
      <span className={cn(compact.dot, online ? compact.dotOnline : compact.dotOffline)} aria-hidden />
      <span className={compact.serverChipName}>{name}</span>
      {storage && (
        <span className={cn(compact.meter, compact.serverChipMeter)} aria-hidden>
          <span className={cn(compact.meterFill, storage.tone)} style={{ transform: `scaleX(${storage.ratio})` }} />
        </span>
      )}
      {percent != null && <span className={compact.serverChipValue}>{percent}%</span>}
    </button>
  );
}

/** Место, прогноз и тариф над настройками сервера, вместе с «Освободить место». */
export function ServerStoragePanel({ online }: { online: boolean }) {
  const status = useVpsRecorderStore((s) => s.status);
  const managed = useVpsRecorderStore((s) => s.managed);
  const clearing = useVpsRecorderStore((s) => Boolean(s.busy.clear));
  const clearBuffer = useVpsRecorderStore((s) => s.clearBuffer);
  const [confirmClear, setConfirmClear] = useState(false);
  const storage = useStorageInfo();
  const plan = activePlan(status);
  const days = plan ? daysLeft(plan.paidUntil) : null;
  const disk = status?.disk;
  if (!disk || !storage) return null;

  return (
    <section className={compact.storagePanel} aria-label="Место на сервере">
      <div className={compact.storagePanelMain}>
        <div className={compact.storagePanelHead}>
          <span>Место</span>
          <b>{storage.usedText}</b>
        </div>
        <span
          className={compact.meter}
          role="progressbar"
          aria-label="Заполнение хранилища"
          aria-valuenow={Math.round(storage.ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className={cn(compact.meterFill, storage.tone)} style={{ transform: `scaleX(${storage.ratio})` }} />
        </span>
        {storage.forecast && <span className={compact.storagePanelHint}>{storage.forecast}</span>}
      </div>
      <div className={compact.storagePanelActions}>
        <button
          type="button"
          className={compact.planLine}
          disabled={clearing || !online}
          title={online ? "Удалить видео старых записей, чтобы освободить место" : "Нет связи с сервером"}
          onClick={() => setConfirmClear(true)}
        >
          <RedesignIcon name={clearing ? "loading" : "trash"} className="size-3" />
          <span>{clearing ? "Очистка…" : "Освободить место"}</span>
        </button>
        {/* An own VPS has no Fetchr plan to extend; only show plans where they apply. */}
        {(plan || managed.active) && (
          <button type="button" className={compact.planLine} onClick={() => void openUrl(plansUrl())} title="Продлить или сменить тариф">
            {plan ? (
              <>
                <b>{plan.plan.name}</b>
                <span className={cn(days != null && days <= 5 && compact.warnText)}>
                  {plan.paidUntil == null ? "оплачен" : days === 0 ? "продлите" : `до ${fmtPaidUntil(plan.paidUntil)}`}
                </span>
              </>
            ) : (
              <span>Тарифы</span>
            )}
            <RedesignIcon name="external" className="size-3" />
          </button>
        )}
      </div>
      <ConfirmModal
        open={confirmClear}
        title="Освободить место на сервере?"
        confirmLabel="Удалить старое видео"
        busy={clearing}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          void clearBuffer(false);
        }}
      >
        <p>
          Сервер удалит видео старых записей. Клипы, закреплённые клипы, метки и куски рядом с ними
          останутся; идущие эфиры не прервутся. Удалённое видео вернуть нельзя.
        </p>
        <p>
          Свободно {fmtBytes(disk.free)} из {fmtBytes(disk.total)}
          {disk.buffer_used != null ? ` · записи занимают ${fmtBytes(disk.buffer_used)}` : ""}
          {disk.buffered_hours != null ? ` · в архиве ~${fmtHours(disk.buffered_hours)}` : ""}.
        </p>
        <p>Когда место кончается, сервер и сам удаляет самые старые записи.</p>
      </ConfirmModal>
    </section>
  );
}

function useStorageInfo() {
  const status = useVpsRecorderStore((s) => s.status);
  const disk = status?.disk;
  if (!disk) return null;
  const plan = activePlan(status);
  const used = disk.buffer_used ?? disk.total - disk.free;
  const limit = plan?.quota ?? disk.buffer_budget ?? disk.total;
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const hours = hoursFor(Math.max(0, limit - used), disk.bytes_per_sec) ?? disk.retention_hours;
  return {
    ratio,
    usedText: `${fmtBytes(used)} из ${plan ? fmtQuota(limit) : fmtBytes(limit)}`,
    forecast: ratio >= 1 ? "новое вытесняет старое" : hours ? `хватит ещё ~${fmtHours(hours)}` : null,
    tone: ratio >= 0.95 ? compact.meterFull : ratio >= 0.8 ? compact.meterWarn : undefined,
  };
}
