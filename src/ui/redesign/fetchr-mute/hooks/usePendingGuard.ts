import { useRef, useState } from "react";
import { useBlocker } from "@tanstack/react-router";

import type { PendingEdits } from "./usePendingEdits";

interface PendingGuardOptions {
  pending: PendingEdits;
  closeFile: () => void;
}

/**
 * Закрытие файла и уход со страницы при неприменённых правках: спросить —
 * применить, сбросить или остаться.
 */
export function usePendingGuard({ pending, closeFile }: PendingGuardOptions) {
  const [closeConfirmOpen, setCloseConfirmOpen] = useState<boolean>(false);
  const pendingCountRef = useRef(pending.pendingCount);
  pendingCountRef.current = pending.pendingCount;

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      pendingCountRef.current > 0 && current.pathname !== next.pathname,
    enableBeforeUnload: false,
    withResolver: true,
  });
  const leaving = blocker.status === "blocked";

  const requestClose = () => {
    if (pending.pendingCount > 0) {
      setCloseConfirmOpen(true);
      return;
    }
    closeFile();
  };

  const confirmApply = async () => {
    if (leaving) {
      // Рендер продолжится в фоне: стор переживает уход со страницы.
      void pending.apply();
      blocker.proceed();
      return;
    }
    setCloseConfirmOpen(false);
    if (await pending.ensureApplied()) closeFile();
  };

  const confirmDiscard = () => {
    pending.discardPending();
    if (leaving) {
      blocker.proceed();
      return;
    }
    setCloseConfirmOpen(false);
    closeFile();
  };

  const confirmCancel = () => {
    if (leaving) blocker.reset();
    setCloseConfirmOpen(false);
  };

  return {
    confirmOpen: leaving || closeConfirmOpen,
    requestClose,
    confirmApply,
    confirmDiscard,
    confirmCancel,
  };
}
