/** Rewrites a JSONL file other processes keep appending to. The API server and
 *  the bot reopen the file by path for every append and hold no lock, so:
 *  the file is read through a handle that survives the rename, the result goes
 *  to a temporary file that replaces the original atomically, and whatever
 *  landed on the old file meanwhile is copied over from that same handle. */

import { chownSync, existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { appendFile, chmod, chown, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Long enough for a writer that opened the file just before the rename to finish. */
const SETTLE_MS = 200;

function parseLines(text) {
  const lines = text.split(/\r?\n/);
  const last = lines.pop();
  const records = [];
  let malformed = 0;
  for (const line of lines) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  // A line without its newline may still be being written: it stays as it is.
  return { records, malformed, fragment: last || "" };
}

/** `transform` gets the parsed records and returns the ones to keep. Lines that
 *  do not parse are dropped and counted: their age and content are unknown. */
export async function rewriteJsonLines(path, transform, { dryRun = false, settleMs = SETTLE_MS } = {}) {
  if (!existsSync(path)) return { before: 0, after: 0, removed: 0, malformed: 0, changed: false };
  const handle = await open(path, "r");
  let closed = false;
  try {
    const { size, mode, uid, gid } = await handle.stat();
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    const original = buffer.toString("utf8");
    const { records, malformed, fragment } = parseLines(original);
    const kept = transform(records);
    const output = `${kept.map((record) => `${JSON.stringify(record)}\n`).join("")}${fragment}`;
    const stats = { before: records.length, after: kept.length, removed: records.length - kept.length, malformed };
    const changed = output !== original.replaceAll("\r\n", "\n");
    if (!changed || dryRun) return { ...stats, changed };

    const temp = `${path}.tmp-${process.pid}`;
    const out = await open(temp, "wx", mode);
    let copied = size;
    const copyTail = async (write) => {
      const { size: grown } = await handle.stat();
      if (grown <= copied) return;
      const tail = Buffer.alloc(grown - copied);
      await handle.read(tail, 0, tail.length, copied);
      copied = grown;
      await write(tail);
    };
    try {
      await out.writeFile(output, "utf8");
      await copyTail((tail) => out.appendFile(tail));
      await out.sync();
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    } finally {
      await out.close();
    }
    try {
      await chmod(temp, mode);
      if (process.getuid?.() === 0) await chown(temp, uid, gid);
      // Windows (development only) refuses to replace a file with an open handle.
      if (process.platform === "win32") {
        await copyTail((tail) => appendFile(temp, tail));
        await handle.close();
        closed = true;
      }
      await rename(temp, path);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }

    if (!closed) {
      await new Promise((done) => setTimeout(done, settleMs));
      await copyTail((tail) => appendFile(path, tail));
    }
    return { ...stats, changed };
  } finally {
    if (!closed) await handle.close();
  }
}

/** Whole-file state (JSON): temporary file, then an atomic replace. Run as root
 *  it keeps the owner, or a service running as another user loses the file. */
export function writeJsonAtomic(path, value, { mode = 0o644 } = {}) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (process.getuid?.() === 0) {
    const { uid, gid } = statSync(existsSync(path) ? path : dirname(path));
    chownSync(temp, uid, gid);
  }
  renameSync(temp, path);
}
