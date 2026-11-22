import { RedesignIcon } from "@/ui/redesign/icons/iconMap";
import { fmtHours, fmtQuota } from "@/ui/redesign/vps-recorder/format";
import { GB, PLANS, QUALITY_PRESETS, fmtPrice, fmtRate, type Currency } from "@/ui/redesign/vps-recorder/plans";
import { StarIcon } from "@/ui/redesign/vps-recorder/StarIcon";
import styles from "@/ui/redesign/vps-recorder/VpsRecorderPage.module.css";

import { STREAMS } from "../content";
import { StreamFrame } from "../components/StreamFrame";
import "./VpsView.css";

/**
 * «Архив VPS» на настоящем CSS-модуле страницы: карточки записей и тарифы
 * выглядят как в приложении. Цены и квоты берутся из plans.ts, поэтому
 * прайс в ролике не разойдётся с приложением.
 */

type Poster = { kind: "image"; src: string } | { kind: "frame"; palette: "dusk" | "arctic" | "ember" | "forest" | "violet"; seed: number };

interface Recording {
  id: string;
  title: string;
  channel: string;
  date: string;
  poster: Poster;
  duration: string;
  size: string;
  chat: number;
  live?: boolean;
}

export const RECORDINGS: Recording[] = [
  { id: "rostik", title: STREAMS.rostik.title, channel: "rostikfacekid", date: "сегодня, 19:04", poster: { kind: "image", src: STREAMS.rostik.thumb }, duration: "3:12:48", size: "эфир", chat: 18420, live: true },
  { id: "xqc", title: STREAMS.xqc.title, channel: "xqc", date: "сегодня, 02:11", poster: { kind: "image", src: STREAMS.xqc.thumb }, duration: "9:41:05", size: "31.8 ГБ", chat: 212904 },
  { id: "leva", title: STREAMS.leva.title, channel: "leva2k", date: "вчера, 21:01", poster: { kind: "image", src: STREAMS.leva.thumb }, duration: "7:48:12", size: "24.1 ГБ", chat: 40211 },
  { id: "hls", title: "Хайпуем на фрикленде", channel: "5opka", date: "вчера, 16:30", poster: { kind: "image", src: STREAMS.hls.thumb }, duration: "4:20:05", size: "13.6 ГБ", chat: 9120 },
  { id: "a", title: "Ночной марафон: финал сезона", channel: "rostikfacekid", date: "22 сен, 23:40", poster: { kind: "frame", palette: "dusk", seed: 3 }, duration: "6:14:22", size: "19.2 ГБ", chat: 15320 },
  { id: "b", title: "IRL: прогулка по Амстердаму", channel: "leva2k", date: "21 сен, 14:05", poster: { kind: "frame", palette: "arctic", seed: 12 }, duration: "3:02:47", size: "9.4 ГБ", chat: 8410 },
  { id: "c", title: "Турнир: гранд-финал", channel: "xqc", date: "20 сен, 20:00", poster: { kind: "frame", palette: "ember", seed: 21 }, duration: "4:55:00", size: "15.3 ГБ", chat: 98012 },
  { id: "d", title: "Разбор нового патча", channel: "rostikfacekid", date: "19 сен, 18:20", poster: { kind: "frame", palette: "violet", seed: 57 }, duration: "1:48:10", size: "5.6 ГБ", chat: 4211 },
];

/** Тариф, который в ролике выбирают, и валюты по порядку переключения */
export const PICKED_PLAN = "streamer";
export const CURRENCY_ORDER: Currency[] = ["rub", "usd", "stars"];

const TABS = [
  { id: "rec", label: "Записи", count: RECORDINGS.length },
  { id: "clips", label: "Клипы", count: 14 },
  { id: "capture", label: "Запись" },
  { id: "plan", label: "Подписка" },
  { id: "server", label: "Сервер" },
];

function PosterArt({ poster }: { poster: Poster }) {
  return poster.kind === "image" ? (
    <img className={styles.posterImage} src={poster.src} alt="" />
  ) : (
    <StreamFrame palette={poster.palette} seed={poster.seed} className={styles.posterImage} />
  );
}

function RecordingCard({ recording }: { recording: Recording }) {
  return (
    <article className={`${styles.card} ${recording.live ? styles.cardLive : ""} vpsCard`} data-p={`vps.card.${recording.id}`}>
      <div className={styles.poster}>
        <PosterArt poster={recording.poster} />
        <span className={styles.posterBadge}>
          {recording.live ? (
            <>
              <span className={styles.recDot} data-p="vps.recDot" />
              <span className={styles.badgeLive}>эфир</span>
            </>
          ) : (
            <span className={styles.badgeArchive}>{recording.size}</span>
          )}
        </span>
        <span className={`${styles.posterDuration} mono`} data-p={recording.live ? "vps.liveDuration" : undefined}>
          {recording.duration}
        </span>
      </div>
      <div className={styles.cardBody}>
        <h3 className={`${styles.cardTitle} vpsCardTitle`}>{recording.title}</h3>
        <div className={styles.cardMeta}>
          <span>{recording.date}</span>
          <span>{recording.channel}</span>
        </div>
        <div className={styles.cardMeta}>
          <span>чат: {recording.chat.toLocaleString("ru-RU")}</span>
        </div>
      </div>
    </article>
  );
}

function PlanCard({ planIndex }: { planIndex: number }) {
  const plan = PLANS[planIndex];
  const hours = plan.quota / QUALITY_PRESETS[0].bytesPerSec / 3600;
  const picked = plan.id === PICKED_PLAN;
  return (
    <div className={`${styles.planCard} vpsPlan`} data-p={`vps.plan.${plan.id}`}>
      <span className="vpsPlanActive" data-p={`vps.plan.${plan.id}.active`} />
      <span className={styles.planName}>{plan.name}</span>
      <span className={styles.planQuota}>{fmtQuota(plan.quota)}</span>
      <span className={styles.planHours}>≈ {fmtHours(hours)} эфира</span>
      <span className={styles.planChannels}>{plan.channels > 1 ? `до ${plan.channels} стримеров разом` : "один стример"}</span>
      <span className={`${styles.planCardPrice} vpsPlanPrice`}>
        {CURRENCY_ORDER.map((currency) => (
          <span className="vpsPrice" data-p={`vps.price.${currency}`} key={currency}>
            {plan.price[currency] === 0 ? "бесплатно" : fmtPrice(plan.price[currency], currency)}
          </span>
        ))}
      </span>
      <span className={styles.planTagline}>{plan.tagline}</span>
      {picked && (
        <span className="vpsDetails" data-p="vps.details">
          <span className={styles.planDetails}>
            {QUALITY_PRESETS.map((preset) => (
              <span className={styles.planDetail} key={preset.label}>
                <span className={styles.planDetailLabel}>{preset.label}</span>
                <span className={styles.planDetailValue}>{fmtHours(plan.quota / preset.bytesPerSec / 3600)} эфира</span>
              </span>
            ))}
            <span className={styles.planDetail}>
              <span className={styles.planDetailLabel}>Одновременная запись</span>
              <span className={styles.planDetailValue}>до {plan.channels} каналов</span>
            </span>
            <span className={styles.planDetail}>
              <span className={styles.planDetailLabel}>Гигабайт обойдётся в</span>
              <span className={styles.planDetailValue}>{fmtRate(plan.price.rub / (plan.quota / GB), "rub")}</span>
            </span>
          </span>
        </span>
      )}
    </div>
  );
}

export function VpsView() {
  return (
    <div className="view vpsView" data-p="view.vps">
      <div className="vpsInner">
        <div className={styles.connectBar}>
          <span className={`${styles.statusPill} ${styles.statusOnline}`}>
            <span className={styles.statusDot} />
            на связи
          </span>
          <span className={`${styles.barMeta} mono`}>recorder@185.22.61.14:22</span>
          <span className={styles.barMeta}>
            <span className="mono">412 ГБ свободно</span>
            <span>в буфере ~96 ч</span>
          </span>
          <span className={styles.barSpacer} />
          <span className="vpsRecChip" data-p="vps.recChip">
            <span className="dot" />
            пишется 1 канал
          </span>
        </div>

        <div className={`${styles.tabs} vpsTabs`} data-p="vps.tabs">
          <span className="vpsTabPill" data-p="vps.tabPill" />
          {TABS.map((tab) => (
            <span className={`${styles.tab} vpsTab`} data-p={`vps.tab.${tab.id}`} key={tab.id}>
              {tab.label}
              {tab.count != null && <span className={styles.tabCount}>{tab.count}</span>}
            </span>
          ))}
        </div>

        <div className="vpsPanes">
          <div className={`${styles.grid} vpsGrid`} data-p="vps.archive">
            {RECORDINGS.map((recording) => (
              <RecordingCard recording={recording} key={recording.id} />
            ))}
          </div>

          <div className={`${styles.panel} vpsPlans`} data-p="vps.plans">
            <div className={styles.planHeader}>
              <div>
                <h2 className={styles.panelTitle}>Подписка</h2>
                <p className={styles.panelHelp}>Расчёт по 1080p60. Начнёте писать — пересчитаем по вашему битрейту.</p>
              </div>
              <div className={styles.planHeaderRight}>
                <div className={`${styles.currencySwitch} vpsCurrency`}>
                  <span className="vpsCurrencyPill" data-p="vps.currencyPill" />
                  <span className={styles.currencyButton} data-p="vps.cur.rub">
                    ₽
                  </span>
                  <span className={styles.currencyButton} data-p="vps.cur.usd">
                    $
                  </span>
                  <span className={styles.currencyButton} data-p="vps.cur.stars">
                    <StarIcon />
                  </span>
                </div>
                <div className={styles.planPrice}>
                  <span className={`${styles.planPriceValue} mono`} data-p="vps.total">
                    0 ₽
                  </span>
                  <span className={styles.planPriceUnit}>в месяц</span>
                </div>
              </div>
            </div>

            <div className={styles.quota}>
              <div className={styles.quotaTrack}>
                <div className={`${styles.quotaFill} vpsQuotaFill`} data-p="vps.quotaFill" />
              </div>
              <div className={styles.quotaMeta}>
                <span data-p="vps.quotaText">38.20 ГБ из 5 ГБ</span>
                <span className={styles.quotaLeft} data-p="vps.quotaLeft">
                  хватит ещё на ~—
                </span>
              </div>
            </div>

            <div className={`${styles.planGrid} vpsPlanGrid`}>
              {PLANS.map((plan, index) => (
                <PlanCard planIndex={index} key={plan.id} />
              ))}
            </div>

            <div className={styles.addonRow}>
              <div>
                <p className={styles.addonTitle}>Дополнительное хранилище</p>
                <p className={styles.panelHelp}>+10 ГБ за 30 ₽ в месяц, можно несколько раз</p>
              </div>
              <div className={styles.addonStepper}>
                <span className={`${styles.stepperButton} vpsStep`}>−</span>
                <span className={styles.stepperValue} data-p="vps.packs">
                  +0 ГБ
                </span>
                <span className={`${styles.stepperButton} vpsStep`} data-p="vps.plus">
                  +
                </span>
              </div>
            </div>

            <div className={styles.checkoutRow}>
              <span className={`${styles.primaryButton} vpsBuy`} data-p="vps.buy">
                <RedesignIcon name="external" size={16} />
                <span data-p="vps.buyText">Приобрести</span>
              </span>
              <p className={styles.panelHelp}>Оплата в Telegram — бот откроется с уже выбранным тарифом.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
