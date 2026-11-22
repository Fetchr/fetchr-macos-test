import { toast } from "sonner";

import { ipc } from "@/lib/ipc";

import { fmtFreed } from "./downloadNames";
import { friendlyVpsError } from "./vpsErrors";

/** Time the user has to press «Отменить» before the server is asked to delete. */
export const UNDO_MS = 5000;

/** A tombstone outlives a poll that left before the delete finished. */
const TOMBSTONE_MS = 30_000;

export type VpsDeleteKind = "recording" | "clip";

export interface VpsDeleteTarget {
  kind: VpsDeleteKind;
  id: string;
  title: string;
}

/** One «Удалить» press: a row or a whole selection, undone together. */
export interface VpsPendingDelete {
  id: string;
  targets: VpsDeleteTarget[];
  /** The server is already deleting it: too late to undo. */
  running: boolean;
}

export interface VpsDeleteResult {
  target: VpsDeleteTarget;
  freed: number;
  error: unknown;
  ok: boolean;
}

export function deleteKey(kind: VpsDeleteKind, id: string): string {
  return `${kind}:${id}`;
}

export function pendingKeys(pending: readonly VpsPendingDelete[]): Set<string> {
  return new Set(pending.flatMap((batch) => batch.targets.map((target) => deleteKey(target.kind, target.id))));
}

// Timer handles and tombstones are not UI state: nothing renders from them.
const timers = new Map<string, number>();
const tombstones = new Map<string, number>();

export function armDeleteTimer(batchId: string, run: () => void): void {
  disarmDeleteTimer(batchId);
  timers.set(batchId, window.setTimeout(run, UNDO_MS));
}

export function disarmDeleteTimer(batchId: string): void {
  const timer = timers.get(batchId);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(batchId);
  toast.dismiss(undoToastId(batchId));
}

export function markDeleted(target: VpsDeleteTarget): void {
  tombstones.set(deleteKey(target.kind, target.id), Date.now() + TOMBSTONE_MS);
}

function isTombstoned(key: string): boolean {
  const until = tombstones.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  tombstones.delete(key);
  return false;
}

/** Drops items deleted moments ago that a poll already in flight still lists. */
export function withoutTombstoned<T>(items: T[], kind: VpsDeleteKind, keyOf: (item: T) => string): T[] {
  if (tombstones.size === 0) return items;
  return items.filter((item) => !isTombstoned(deleteKey(kind, keyOf(item))));
}

export function undoToastId(batchId: string): string {
  return `vps-undo-${batchId}`;
}

function countLabel(targets: readonly VpsDeleteTarget[]): string {
  if (targets.every((target) => target.kind === "recording")) return `записей: ${targets.length}`;
  if (targets.every((target) => target.kind === "clip")) return `клипов: ${targets.length}`;
  return `объектов: ${targets.length}`;
}

function singleLabel(target: VpsDeleteTarget): string {
  return target.kind === "recording" ? `Запись «${target.title}» удалена` : `Клип «${target.title}» удалён`;
}

/** Text of the «Удалено · Отменить» toast. */
export function scheduledMessage(targets: readonly VpsDeleteTarget[]): string {
  return targets.length === 1 ? singleLabel(targets[0]) : `Удалено ${countLabel(targets)}`;
}

/** Final toast once the server answered for every item of the batch. */
export function reportDeleteResults(results: readonly VpsDeleteResult[]): void {
  const done = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  const freed = done.reduce((sum, result) => sum + result.freed, 0);
  const freedText = freed > 0 ? `освобождено ${fmtFreed(freed)}` : undefined;
  if (failed.length === 0) {
    if (results.length > 1) toast.success(`Удалено ${countLabel(done.map((result) => result.target))}`, { description: freedText });
    else if (freedText) toast.success(`На сервере ${freedText}`);
    return;
  }
  const reason = friendlyVpsError(failed[0].error).message;
  const title =
    results.length === 1
      ? `Не удалось удалить «${failed[0].target.title}» — вернули в список.`
      : `Не удалось удалить ${failed.length} из ${results.length} — вернули в список.`;
  toast.error(title, { description: freedText ? `${reason} Остальное удалено, ${freedText}.` : reason });
}

export function newBatchId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function removeOnServer(target: VpsDeleteTarget): Promise<number> {
  if (target.kind === "recording") return ipc.vpsRecordingDelete(target.id);
  await ipc.vpsClipDelete(target.id);
  return 0;
}

export async function removeAll(targets: readonly VpsDeleteTarget[]): Promise<VpsDeleteResult[]> {
  let results: VpsDeleteResult[] = [];
  // One by one: a burst of parallel deletes on a slow archive times out.
  for (const target of targets) {
    try {
      const freed = await removeOnServer(target);
      markDeleted(target);
      results = [...results, { target, freed, error: null, ok: true }];
    } catch (error) {
      results = [...results, { target, freed: 0, error, ok: false }];
    }
  }
  return results;
}

export function isPosterOf(key: string, recordings: Set<string>, clips: Set<string>): boolean {
  if (key.startsWith("clip:")) return clips.has(key.slice(5));
  const session = key.startsWith("rec:") ? key.slice(4, key.lastIndexOf(":")) : "";
  return recordings.has(session);
}
