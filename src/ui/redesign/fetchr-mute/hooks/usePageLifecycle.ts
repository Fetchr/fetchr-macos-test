import { useEffect, useState } from "react";

import { useFetchrMuteStore } from "@/stores/fetchrMute";

/** Активность страницы для стора и автоскрытие уведомлений. */
const NOTICE_MS = 9000;
/** Уведомление с кнопкой держится дольше: его надо успеть прочитать и нажать. */
const NOTICE_WITH_ACTION_MS = 30000;

export function usePageLifecycle(
  notice: string | null,
  hasAction: boolean,
  setNotice: (msg: string | null) => void,
) {
  // Sync mount/active state with store
  useEffect(() => {
    useFetchrMuteStore.setState({ isPageActive: true });

    // If processing completed while we were away, transition directly to the completed path
    const {
      processing: storeProcessing,
      pendingOutputPath: storePendingPath,
      outputPath: storeOutputPath,
      isMutingAnimation: storeShowRunning,
      taskId: storeTaskId,
    } = useFetchrMuteStore.getState();
    if (!storeProcessing && storePendingPath && !storeOutputPath) {
      useFetchrMuteStore.setState({ outputPath: storePendingPath });
    }
    // Ушли во время «шоу удаления»: анализ уже готов, показ прерван. Не
    // запускаем его заново и не ждём плеер — сразу отдаём результат.
    if (storeShowRunning && storePendingPath && !storeTaskId) {
      useFetchrMuteStore.setState({
        isMutingAnimation: false,
        processing: false,
        outputPath: storePendingPath,
        scanProgress: 0,
        currentScanTime: 0,
      });
    }

    return () => {
      useFetchrMuteStore.setState({ isPageActive: false });
    };
  }, []);

  // Наведение на уведомление ставит автоскрытие на паузу.
  const [noticeHovered, setNoticeHovered] = useState(false);
  useEffect(() => {
    if (!notice) setNoticeHovered(false);
  }, [notice]);

  // Уведомления (не ошибки) гаснут сами через несколько секунд.
  useEffect(() => {
    if (!notice || noticeHovered) return;
    const timer = window.setTimeout(
      () => setNotice(null),
      hasAction ? NOTICE_WITH_ACTION_MS : NOTICE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [notice, hasAction, setNotice, noticeHovered]);

  return { setNoticeHovered };
}
