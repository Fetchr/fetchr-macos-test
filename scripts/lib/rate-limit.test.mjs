import assert from "node:assert/strict";
import { test } from "node:test";

import { createRateLimiter } from "./rate-limit.mjs";

function clock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

test("allows up to the limit inside the window, then refuses", () => {
  const time = clock();
  const allow = createRateLimiter({ limit: 3, windowMs: 60_000, now: time.now });
  assert.equal(allow("1.2.3.4"), true);
  assert.equal(allow("1.2.3.4"), true);
  assert.equal(allow("1.2.3.4"), true);
  assert.equal(allow("1.2.3.4"), false);
});

test("the window slides: old hits stop counting", () => {
  const time = clock();
  const allow = createRateLimiter({ limit: 2, windowMs: 60_000, now: time.now });
  allow("a");
  time.advance(30_000);
  allow("a");
  assert.equal(allow("a"), false);
  time.advance(30_001);
  assert.equal(allow("a"), true);
});

test("keys are counted separately", () => {
  const allow = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
  assert.equal(allow("a"), true);
  assert.equal(allow("b"), true);
  assert.equal(allow("a"), false);
});

test("a refused hit does not extend the block", () => {
  const time = clock();
  const allow = createRateLimiter({ limit: 1, windowMs: 10_000, now: time.now });
  allow("a");
  time.advance(9_000);
  assert.equal(allow("a"), false);
  time.advance(1_001);
  assert.equal(allow("a"), true);
});

test("memory stays bounded by maxKeys, expired keys are dropped first", () => {
  const time = clock();
  const allow = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 100, now: time.now });
  for (let index = 0; index < 100; index += 1) allow(`old-${index}`);
  time.advance(1_001);
  allow("live");
  for (let index = 0; index < 500; index += 1) allow(`new-${index}`);
  assert.ok(allow.size() <= 100, `size ${allow.size()} exceeds maxKeys`);
});
