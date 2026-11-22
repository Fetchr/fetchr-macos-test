import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useSettings } from "@/stores/settings";
import { useUI } from "@/stores/ui";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./SettingsPage.module.css";
import helpStyles from "./HelpSettingsCard.module.css";

interface FaqItem {
  question: string;
  answer: string;
}

const FAQ_ITEMS: FaqItem[] = [
  {
    question: "Почему задача завершается с ошибкой?",
    answer:
      "Убедись, что yt-dlp и ffmpeg установлены и указаны в настройках «Инструменты». Проверь логи — там будет точная причина ошибки. Часто помогает обновление yt-dlp через кнопку в настройках инструментов.",
  },
  {
    question: "Как скачать удалённый VOD с Twitch?",
    answer:
      "Перейди в режим «M3U8 Finder». Введи никнейм стримера и дату трансляции. Fetchr проверит публичные трекеры (lossless.tv, Sullygnome и др.) и найдёт M3U8-ссылку, если запись существует.",
  },
  {
    question: "Рендер чата очень медленный — как ускорить?",
    answer:
      "В настройках «Производительность» нажми «Определить железо» — Fetchr применит оптимальный профиль для твоего GPU. Также убедись, что в настройках чата выбран режим «Direct» (не Intermediate).",
  },
  {
    question: "Можно ли записывать несколько стримов одновременно?",
    answer:
      "Да. В режиме «Запись стримов» добавь несколько каналов. Fetchr будет следить за каждым и начнёт запись при выходе стримера в эфир. Количество параллельных задач ограничено настройкой «Макс. задач» в Общих настройках.",
  },
  {
    question: "Блюр спонсоров не срабатывает — что делать?",
    answer:
      "Убедись, что загружено референс-изображение (кадр из видео с логотипом). Зона должна охватывать логотип с небольшим запасом. Если логотип появляется в разных местах — добавь несколько зон.",
  },
  {
    question: "Как изменить язык интерфейса?",
    answer:
      "В настройках «Общие» → поле «Язык». Поддерживаются русский и английский. Изменение применяется сразу без перезапуска.",
  },
  {
    question: "Где хранятся файлы после скачивания?",
    answer:
      "В папке, указанной в настройках «Общие» → «Рабочая папка». По умолчанию это папка Загрузки. Изменить можно там же через кнопку «Выбрать папку».",
  },
  {
    question: "Fetchr не видит мой GPU — почему?",
    answer:
      "Нажми «Определить железо» в разделе «Производительность». Для NVIDIA нужны актуальные драйверы. Для AMD — убедись, что установлен AMF (обычно входит в пакет драйверов Radeon Software). На macOS используется VideoToolbox автоматически.",
  },
];

export function HelpSettingsCard() {
  const { t } = useTranslation();
  const setOnboardingCompleted = useSettings((s) => s.setOnboardingCompleted);
  const setSetupCompleted = useSettings((s) => s.setSetupCompleted);
  const openTour = useUI((s) => s.openTour);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  // No page reload: the tour is mounted globally and driven by the UI store.
  const restartOnboarding = () => {
    setOnboardingCompleted(false);
    openTour();
  };

  return (
    <>
      {/* Onboarding card */}
      <div className={styles.card}>
        <div className={helpStyles.cardInner}>
          <div className={helpStyles.onboardingRow}>
            <div>
              <div className={helpStyles.cardTitle}>
                {t("onboarding.card_title", "Обучение")}
              </div>
              <div className={helpStyles.cardSubtitle}>
                {t(
                  "onboarding.card_subtitle",
                  "Пошаговый тур по всем режимам Fetchr с визуальными подсказками.",
                )}
              </div>
            </div>
            <div className={helpStyles.btnGroup}>
              {/* Мастер снова спросит инструменты и докачает то, чего не хватает */}
              <button
                className={helpStyles.btnSecondary}
                type="button"
                onClick={() => setSetupCompleted(false)}
              >
                <RedesignIcon name="preset" className={helpStyles.btnIcon} />
                {t("setup.rerun", "Первоначальная настройка")}
              </button>
              <button
                className={helpStyles.btnRepeat}
                type="button"
                onClick={restartOnboarding}
              >
                <RedesignIcon name="reset" className={helpStyles.btnIcon} />
                {t("onboarding.restart", "Повторить обучение")}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* FAQ card */}
      <div className={styles.card}>
        <div className={helpStyles.cardInner}>
          <div className={helpStyles.cardTitle}>Частые вопросы</div>
          <div className={helpStyles.faqList}>
            {FAQ_ITEMS.map((item, i) => (
              <div key={i} className={helpStyles.faqItem}>
                <button
                  className={helpStyles.faqQuestion}
                  type="button"
                  onClick={() => setOpenIndex(openIndex === i ? null : i)}
                >
                  <span>{item.question}</span>
                  <RedesignIcon
                    name="chevronDown"
                    className={`${helpStyles.faqChevron} ${openIndex === i ? helpStyles.faqChevronOpen : ""}`}
                  />
                </button>
                {openIndex === i && (
                  <div className={helpStyles.faqAnswer}>{item.answer}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
