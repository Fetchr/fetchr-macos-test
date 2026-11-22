import { cn } from "@/lib/utils";
import { RedesignIcon } from "@/ui/redesign/icons/iconMap";

import styles from "./SourceProgressPanel.module.css";
import {
  STREAM_SOURCE_LABELS,
  sourcesProgress,
  type StreamSourceStage,
  type StreamSourceState,
} from "./sourceProgress";

const STAGE_TEXT: Record<StreamSourceStage, string> = {
  waiting: "в очереди",
  started: "запрос…",
  cloudflare: "проходим Cloudflare…",
  done: "готово",
  failed: "ошибка",
  skipped: "не понадобился",
};

interface SourceProgressPanelProps {
  sources: StreamSourceState[];
  compact?: boolean;
}

export function SourceProgressPanel({ sources, compact }: SourceProgressPanelProps) {
  const percent = Math.round(sourcesProgress(sources) * 100);
  return (
    <div className={cn(styles.panel, compact && styles.compact)} role="status" aria-live="polite">
      <div className={styles.head}>
        <span>Загружаем список стримов</span>
        <span className={styles.percent}>{percent}%</span>
      </div>
      <div
        className={styles.bar}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span className={styles.fill} style={{ width: `${Math.max(percent, 6)}%` }} />
      </div>
      <ul className={styles.list}>
        {sources.map((source) => {
          const label = STREAM_SOURCE_LABELS[source.id];
          return (
            <li key={source.id} className={styles.item} data-stage={source.stage} title={source.detail ?? undefined}>
              <StageIcon stage={source.stage} />
              <span className={styles.name}>{label.name}</span>
              {!compact && <span className={styles.hint}>{label.hint}</span>}
              <span className={styles.stage}>{STAGE_TEXT[source.stage]}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StageIcon({ stage }: { stage: StreamSourceStage }) {
  if (stage === "started" || stage === "cloudflare") {
    return <RedesignIcon name="loading" className={cn(styles.icon, "animate-spin")} />;
  }
  if (stage === "done") return <RedesignIcon name="check" className={styles.icon} />;
  if (stage === "failed") return <RedesignIcon name="close" className={styles.icon} />;
  return <span className={styles.dot} aria-hidden />;
}
