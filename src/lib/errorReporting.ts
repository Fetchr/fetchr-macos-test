import { ipc } from "@/lib/ipc";

/** Upper bound per page load: a render loop that throws on every frame must
 *  not flood the IPC bridge. The backend groups and rate-limits as well. */
const MAX_REPORTS_PER_SESSION = 50;

let sent = 0;

function describe(value: unknown): { message: string; stack: string | null } {
  if (value instanceof Error) {
    return { message: value.message || value.name, stack: value.stack ?? null };
  }
  if (typeof value === "string") {
    return { message: value, stack: null };
  }
  try {
    return { message: JSON.stringify(value) ?? String(value), stack: null };
  } catch {
    return { message: String(value), stack: null };
  }
}

function send(kind: string, value: unknown, fallbackMessage?: string): void {
  if (sent >= MAX_REPORTS_PER_SESSION) {
    return;
  }
  sent += 1;
  const { message, stack } = describe(value);
  ipc
    .reportClientError(kind, message || fallbackMessage || kind, stack)
    .catch(() => {
      // Reporting must never surface as an error of its own.
    });
}

/** Forwards uncaught exceptions and unhandled promise rejections. */
export function installErrorReporting(): void {
  window.addEventListener("error", (event) => {
    send("window_error", event.error ?? event.message, event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    send("unhandled_rejection", event.reason);
  });
}
