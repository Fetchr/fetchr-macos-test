import studio from "./ChatStudio.module.css";

interface Toggle {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

interface ChatStyleTogglesProps {
  showBadges: boolean;
  showTimestamps: boolean;
  showAvatars: boolean;
  showBttv: boolean;
  showFfz: boolean;
  show7tv: boolean;
  saveCleanVideo: boolean;
  alphaBackground: boolean;
  onShowBadgesChange: (value: boolean) => void;
  onShowTimestampsChange: (value: boolean) => void;
  onShowAvatarsChange: (value: boolean) => void;
  onShowBttvChange: (value: boolean) => void;
  onShowFfzChange: (value: boolean) => void;
  onShow7tvChange: (value: boolean) => void;
  onSaveCleanVideoChange: (value: boolean) => void;
  onAlphaBackgroundChange: (value: boolean) => void;
}

/** Переключатели вида чата сгруппированными списками, как в настройках. */
export function ChatStyleToggles(props: ChatStyleTogglesProps) {
  const groups: Array<{ title: string; items: Toggle[] }> = [
    {
      title: "Отображение",
      items: [
        { label: "Значки", checked: props.showBadges, onChange: props.onShowBadgesChange },
        { label: "Время сообщений", checked: props.showTimestamps, onChange: props.onShowTimestampsChange },
        { label: "Аватары", checked: props.showAvatars, onChange: props.onShowAvatarsChange },
      ],
    },
    {
      title: "Смайлы",
      items: [
        { label: "BTTV", checked: props.showBttv, onChange: props.onShowBttvChange },
        { label: "FFZ", checked: props.showFfz, onChange: props.onShowFfzChange },
        { label: "7TV", checked: props.show7tv, onChange: props.onShow7tvChange },
      ],
    },
    {
      title: "Вывод",
      items: [
        { label: "Чистая запись", hint: "Видео без чата рядом с готовым", checked: props.saveCleanVideo, onChange: props.onSaveCleanVideoChange },
        { label: "Альфа-канал", hint: "Чат на прозрачном фоне для монтажа", checked: props.alphaBackground, onChange: props.onAlphaBackgroundChange },
      ],
    },
  ];

  return (
    <>
      {groups.map((group) => (
        <div key={group.title} className={studio.section}>
          <span className={studio.label}>{group.title}</span>
          <div className={studio.toggleList}>
            {group.items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="switch"
                aria-checked={item.checked}
                className={studio.toggleRow}
                onClick={() => item.onChange(!item.checked)}
              >
                <span className={studio.toggleText}>
                  <span>{item.label}</span>
                  {item.hint && <small>{item.hint}</small>}
                </span>
                <span className={studio.switch} aria-hidden />
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
