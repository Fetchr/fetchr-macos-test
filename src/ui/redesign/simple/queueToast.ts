import { toast } from "sonner";

import i18n from "@/i18n";
import { ipc } from "@/lib/ipc";

const TOAST_MS = 8000;

/** Снимает только что поставленные задачи: сперва отмена, потом удаление из списка. */
export async function undoQueued(jobIds: readonly string[]): Promise<number> {
  const results = await Promise.all(
    jobIds.map(async (id) => {
      try {
        await ipc.cancelJob(id).catch(() => undefined);
        return await ipc.removeJob(id);
      } catch {
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

/** Тост «Добавлено: N» с отменой и переходом в загрузки. Окно при этом свободно для новой ссылки. */
export function showQueuedToast(jobIds: readonly string[], openQueue: () => void): void {
  if (jobIds.length === 0) return;
  const t = i18n.t.bind(i18n);
  const id = toast.success(t("simple.toast_added", "Добавлено: {{count}}", { count: jobIds.length }), {
    description: t("simple.toast_added_hint", "Загрузка начнётся, когда освободится место."),
    duration: TOAST_MS,
    action: {
      label: t("simple.undo", "Отменить"),
      onClick: () => {
        void undoQueued(jobIds).then((removed) => {
          toast.dismiss(id);
          if (removed > 0) {
            toast(t("simple.toast_undone", "Убрано из очереди: {{count}}", { count: removed }));
          } else {
            toast.error(t("simple.toast_undo_failed", "Не получилось отменить: задачи уже идут. Останови их в «Загрузках»."));
          }
        });
      },
    },
    cancel: {
      label: t("simple.open_queue", "Открыть загрузки"),
      onClick: openQueue,
    },
  });
}
