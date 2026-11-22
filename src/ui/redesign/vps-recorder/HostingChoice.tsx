import { useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { cn } from "@/lib/utils";
import { useVpsRecorderStore } from "@/stores/vpsRecorder";
import { RedesignIcon, type RedesignIconName } from "@/ui/redesign/icons/iconMap";

import { cheapestPaidPrice, fmtRub, plansUrl } from "./plans";
import { VpsConnectPanel } from "./VpsConnectPanel";
import styles from "./HostingChoice.module.css";

type Hosting = "fetchr" | "own";

interface Option {
  id: Hosting;
  icon: RedesignIconName;
  title: string;
  price: ReactNode;
  points: string[];
  recommended?: boolean;
}

const OPTIONS: Option[] = [
  {
    id: "fetchr",
    icon: "sparkle",
    title: "Сервер Fetchr",
    price: `от ${fmtRub(cheapestPaidPrice())} в месяц`,
    points: [
      "Сервер держим мы, настраивать ничего не нужно",
      "Место и число каналов по тарифу",
      "Оплата банковской картой в рублях",
    ],
    recommended: true,
  },
  {
    id: "own",
    icon: "secure",
    title: "Своя VPS",
    price: "бесплатно",
    points: [
      "Любой Linux-сервер с доступом по SSH",
      "Fetchr сам установит на сервер программу записи",
      "Места столько, сколько на диске",
    ],
  },
];

/** First visit: where the recorder will live. Both answers end at the same
 *  archive; they only differ in who owns the machine. */
export function HostingChoice() {
  const [hosting, setHosting] = useState<Hosting | null>(null);
  const connectManaged = useVpsRecorderStore((s) => s.connectManaged);
  const connectError = useVpsRecorderStore((s) => s.connectError);
  const busy = useVpsRecorderStore((s) => s.busy);

  return (
    <section className={styles.choice}>
      <div className={styles.intro}>
        <h2 className={styles.title}>Где будет жить ваш архив</h2>
        <p className={styles.lead}>
          Сервер ловит эфир сам и пишет его вместе с чатом, даже когда компьютер выключен. Потом
          вы смотрите запись здесь, режете клипы на сервере и скачиваете только нужное.
        </p>
      </div>

      <div className={styles.options} role="radiogroup" aria-label="Где хранить архив">
        {OPTIONS.map((option) => {
          const selected = hosting === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={cn(
                styles.option,
                option.recommended && styles.optionFeatured,
                selected && styles.optionSelected,
              )}
              onClick={() => setHosting(option.id)}
            >
              <span className={styles.optionHead}>
                <span className={styles.optionIcon} aria-hidden="true">
                  <RedesignIcon name={option.icon} />
                </span>
                <span className={styles.optionTitle}>{option.title}</span>
                {option.recommended && <span className={styles.badge}>Проще всего</span>}
                <span className={styles.radio} aria-hidden="true">
                  {selected && <RedesignIcon name="check" />}
                </span>
              </span>
              <span className={styles.optionPrice}>{option.price}</span>
              <span className={styles.points}>
                {option.points.map((point) => (
                  <span key={point} className={styles.point}>
                    <RedesignIcon name="check" className={styles.pointIcon} />
                    {point}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>

      {hosting === null && (
        <div className={styles.handoff}>
          <div className={styles.handoffText}>
            <strong>Уже оплатили тариф на fetchr.fun?</strong>
            <span>Подключим ваш архив Fetchr к этому компьютеру — настраивать ничего не нужно.</span>
            {connectError && <span role="alert">{connectError}</span>}
          </div>
          <button
            type="button"
            className={styles.handoffButton}
            disabled={busy.managed}
            onClick={() => void connectManaged()}
          >
            <RedesignIcon name="check" />
            {busy.managed ? "Подключаем…" : "У меня уже есть тариф"}
          </button>
        </div>
      )}
      {hosting === "fetchr" && (
        <div className={styles.handoff}>
          <div className={styles.handoffText}>
            <strong>Тарифы и оплата — на сайте</strong>
            <span>
              Выберите тариф на fetchr.fun, оплата картой в рублях. После оплаты архив подключится
              сам — или нажмите «Уже оплатил».
            </span>
            {connectError && <span role="alert">{connectError}</span>}
          </div>
          <button
            type="button"
            className={styles.handoffButton}
            onClick={() => void openUrl(plansUrl())}
          >
            <RedesignIcon name="external" />
            Открыть тарифы
          </button>
          <button
            type="button"
            className={styles.handoffButton}
            disabled={busy.managed}
            onClick={() => void connectManaged()}
          >
            <RedesignIcon name="check" />
            {busy.managed ? "Подключаем…" : "Уже оплатил"}
          </button>
        </div>
      )}
      {hosting === "own" && <VpsConnectPanel />}
    </section>
  );
}
