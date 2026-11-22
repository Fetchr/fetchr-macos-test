#!/usr/bin/env node
/** Refuses a commit that adds a secret or a secret file (.githooks/pre-commit).
 *
 *   node scripts/secret-scan.mjs          staged changes (the hook)
 *   node scripts/secret-scan.mjs --all    every tracked file (CI, one-off audit)
 *
 * A reviewed false positive passes with "secret-scan: allow" on its line. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { addedLines, findSecrets, forbiddenPath } from "./lib/secret-scan.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const list = (output) => output.split("\0").filter(Boolean);

function trackedLines(files) {
  return files.flatMap((file) => {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    if (text.includes("\0")) return [];
    return text.split(/\r?\n/).map((line, index) => ({ file, line: index + 1, text: line }));
  });
}

const all = process.argv.includes("--all");
const files = all
  ? list(git("ls-files", "-z"))
  : list(git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"));
const lines = all
  ? trackedLines(files)
  : addedLines(git("diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR"));

const badFiles = files.filter(forbiddenPath);
const hits = findSecrets(lines);

if (badFiles.length === 0 && hits.length === 0) process.exit(0);

console.error("secret-scan: refusing — this looks like a credential:");
for (const file of badFiles) console.error(`  ${file}: secret file, keep it out of git`);
for (const hit of hits) console.error(`  ${hit.file}:${hit.line}: ${hit.rule} ${hit.preview}`);
console.error('Move it to build.env / an env var. A reviewed false positive: add "secret-scan: allow" to the line.');
process.exit(1);
