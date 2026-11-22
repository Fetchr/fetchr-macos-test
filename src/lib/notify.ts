import { toast } from "sonner";

import i18n from "@/i18n";

/**
 * Single entry point for surfacing errors to the user.
 * Shows a toast (sonner) and always logs to the console for debugging.
 */
export function notifyError(message: string, err?: unknown): void {
  if (err !== undefined) {
    console.error(message, err);
  } else {
    console.error(message);
  }
  const detail = err === undefined ? undefined : String((err as any)?.message ?? err);
  toast.error(message, detail ? { description: detail } : undefined);
}

export function notifySuccess(message: string, description?: string): void {
  toast.success(message, description ? { description } : undefined);
}

export function notifyInfo(message: string): void {
  toast(message);
}

export function notifyErrorKey(key: string, fallback: string, err?: unknown): void {
  notifyError(i18n.t(key, fallback), err);
}
