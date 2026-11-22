import type { ReactNode } from "react";

import { useBoot } from "@/stores/boot";

/**
 * Приложение монтируется, только когда лицензия подтверждена. Проверку,
 * активацию и обновление при запуске показывает заставка поверх.
 */
export function BootGate({ children }: { children: ReactNode }) {
  const unlocked = useBoot((s) => s.unlocked);
  return unlocked ? <>{children}</> : null;
}
