/** Site analytics beacon (`POST /analytics/hit`), cookieless.
 *
 * A hit becomes a handful of daily counters (page, referrer host, UTM source,
 * device class, browser family, event). Nothing about the visitor is stored.
 * Unique visitors are counted Plausible-style: a hash of address + user agent
 * under a random key that lives in memory only and is replaced every day, so a
 * visitor cannot be followed from one day to the next, nor at all from disk. */

import { createHmac, randomBytes } from "node:crypto";

import { ClientError } from "../http-errors.mjs";
import { createRateLimiter } from "../rate-limit.mjs";
import { dayKey } from "./counters.mjs";

export const SITE_EVENTS = new Set([
  "download_click",
  "bot_click",
  "channel_click",
  "buy_click",
  "account_login",
  "grab_info",
  "grab_job",
  "grab_done",
  "grab_error",
  "cta_click",
]);

const OWN_HOSTS = ["fetchr.fun", "www.fetchr.fun", "fetchr.ru", "ru.fetchr.fun", "localhost", "127.0.0.1"];
const SLUG = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
export const BOT_UA = new RegExp(
  [
    "bot", "crawl", "spider", "slurp", "headless", "phantom", "selenium", "puppeteer", "playwright", "webdriver",
    "preview", "monitor", "uptime", "pingdom", "lighthouse", "pagespeed", "gtmetrix", "facebookexternalhit",
    "telegram", "whatsapp", "vkshare", "skype", "discord", "slack", "embedly", "yandex(?!browser|searchbrowser)",
    "curl", "wget", "python", "scrapy", "axios", "node-fetch", "undici", "go-http", "okhttp", "java/", "libwww",
    "httpclient", "reqwest", "postman", "insomnia", "semrush", "ahrefs", "mj12", "dotbot", "petalsearch",
    "bytespider", "gptbot", "claudebot", "ccbot", "perplexity", "applebot", "dataforseo", "serpstat", "megaindex",
  ].join("|"),
  "i",
);

/** Views per visitor per day past which the visitor is treated as a robot. */
const MAX_VIEWS_PER_VISITOR = 80;
const OWN_ORIGINS = ["https://fetchr.fun", "https://www.fetchr.fun", "https://fetchr.ru", "https://ru.fetchr.fun"];

/** Why a beacon request does not look like a person's browser, or null.
 *  Browsers always send Accept-Language; their own requests carry
 *  Sec-Fetch-Site same-origin and, for a POST, our Origin. */
export function robotReason(ua, headers = {}) {
  if (!ua) return "no_agent";
  if (BOT_UA.test(ua)) return "agent";
  if (!/mozilla\//i.test(ua)) return "agent";
  if (!headers["accept-language"]) return "no_language";
  const site = headers["sec-fetch-site"];
  if (site && site !== "same-origin") return "cross_site";
  const origin = headers.origin;
  if (origin && !OWN_ORIGINS.includes(String(origin).toLowerCase())) return "cross_site";
  return null;
}
const MAX_VISITORS_PER_DAY = 200_000;

const letters = (value) => (/^[a-z]{2,20}$/.test(String(value || "")) ? String(value) : null);

export function normalizePath(value) {
  let path;
  try {
    path = new URL(String(value || "/"), "https://fetchr.fun").pathname.toLowerCase();
  } catch {
    return "/other";
  }
  path = path.replace(/\/index\.html?$/, "/").replace(/\/{2,}/g, "/");
  if (path.length > 1 && !path.endsWith("/") && !/\.[a-z0-9]+$/.test(path)) path += "/";
  return /^\/[a-z0-9_\-/.]{0,99}$/.test(path) ? path : "/other";
}

export function referrerHost(value) {
  if (!value) return "direct";
  try {
    const host = new URL(String(value)).hostname.toLowerCase().replace(/^www\./, "");
    if (!host || OWN_HOSTS.includes(host) || OWN_HOSTS.includes(`www.${host}`)) return null;
    if (/^(.+\.)?(google|yandex|bing|duckduckgo)\.[a-z.]+$/.test(host)) return host.replace(/^.*?(google|yandex|bing|duckduckgo)\..*$/, "$1");
    return /^[a-z0-9.-]{1,80}$/.test(host) ? host : "other";
  } catch {
    return "other";
  }
}

export function slug(value) {
  const text = String(value || "").trim().toLowerCase().slice(0, 40);
  return SLUG.test(text) ? text : null;
}

export function classifyAgent(ua) {
  const text = String(ua || "");
  const os = /windows/i.test(text) ? "windows"
    : /iphone|ipad|ipod/i.test(text) ? "ios"
    : /android/i.test(text) ? "android"
    : /mac os x|macintosh/i.test(text) ? "mac"
    : /linux|x11/i.test(text) ? "linux"
    : "other";
  const device = /ipad|tablet/i.test(text) ? "tablet" : /mobile|iphone|android/i.test(text) ? "mobile" : "desktop";
  const browser = /yabrowser/i.test(text) ? "yandex"
    : /edg\//i.test(text) ? "edge"
    : /opr\/|opera/i.test(text) ? "opera"
    : /firefox|fxios/i.test(text) ? "firefox"
    : /chrome|crios|chromium/i.test(text) ? "chrome"
    : /safari/i.test(text) ? "safari"
    : "other";
  return { os, device, browser };
}

export function createSiteHits({ counters, now = () => Date.now(), perIp = { limit: 300, windowMs: 10 * 60_000 } }) {
  const allowIp = createRateLimiter({ ...perIp, now });
  let day = "";
  let key = randomBytes(32);
  let visitors = new Set();
  let views = new Map();

  /** A new day gets a new key: yesterday's hashes cannot be matched any more. */
  function rollover() {
    const today = dayKey(now());
    if (today === day) return;
    day = today;
    key = randomBytes(32);
    visitors = new Set();
    views = new Map();
  }

  /** Whether this visitor (or, with `scope`, this visitor on this page) is new today. */
  function visitorIsNew(ip, ua, scope = "") {
    rollover();
    const hash = createHmac("sha256", key).update(`${ip}|${ua}|${scope}`).digest("base64url").slice(0, 16);
    if (visitors.has(hash) || visitors.size >= MAX_VISITORS_PER_DAY) return false;
    visitors.add(hash);
    return true;
  }

  /** Counts this visitor's views today; past the limit it is a robot. */
  function tooManyViews(ip, ua) {
    rollover();
    const hash = createHmac("sha256", key).update(`${ip}|${ua}`).digest("base64url").slice(0, 16);
    const seen = (views.get(hash) || 0) + 1;
    if (views.size < MAX_VISITORS_PER_DAY || views.has(hash)) views.set(hash, seen);
    return seen > MAX_VIEWS_PER_VISITOR;
  }

  /** Returns the HTTP status to answer with; the body is always empty. */
  function ingest(body, { ip = "", ua = "", headers = {} } = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ClientError(400, "bad_hit");
    if (!allowIp(ip || "unknown")) return 429;
    const reason = robotReason(ua, headers);
    if (reason) {
      counters.bump("site.bots");
      counters.bump(`bot:${reason}`);
      return 204;
    }
    if (body.t === "pv" && tooManyViews(ip, ua)) {
      counters.bump("site.bots");
      counters.bump("bot:too_many_views");
      return 204;
    }
    const path = normalizePath(body.p);
    if (body.t === "pv") {
      countPageview(path, body, ip, ua);
      return 204;
    }
    if (body.t === "ev") {
      const event = slug(body.e);
      if (!event || !SITE_EVENTS.has(event)) throw new ClientError(400, "bad_event");
      // Letters only: platforms and labels, never an id or a nonce.
      const value = letters(body.v);
      const kind = letters(body.k);
      counters.bump(`ev:${event}`);
      counters.bump(`evpage:${event}:${path}`);
      if (value) {
        counters.bump(`ev:${event}:${value}`);
        counters.bump(`evpv:${event}:${path}:${value}`);
      }
      if (kind) {
        counters.bump(`evk:${event}:${kind}`);
        counters.bump(`evpk:${event}:${path}:${kind}`);
      }
      return 204;
    }
    throw new ClientError(400, "bad_hit");
  }

  function countPageview(path, body, ip, ua) {
    const { os, device, browser } = classifyAgent(ua);
    counters.bump("site.pageviews");
    counters.bump(`page:${path}`);
    if (body.i === 1) counters.bump("site.engaged");
    if (visitorIsNew(ip, ua, path)) counters.bump(`pagevis:${path}`);
    const fresh = visitorIsNew(ip, ua);
    if (!fresh) return;
    counters.bump("site.visitors");
    counters.bump(`entry:${path}`);
    counters.bump(`device:${device}`);
    counters.bump(`os:${os}`);
    counters.bump(`browser:${browser}`);
    const ref = referrerHost(body.r);
    if (ref) counters.bump(`ref:${ref}`);
    const source = slug(body.u);
    if (source) counters.bump(`utm:${source}`);
  }

  return { ingest };
}

/** The fetchr.fun page a Referer points at, or null for other sites. */
export function sitePageOf(referer) {
  if (!referer) return null;
  try {
    const url = new URL(String(referer));
    const host = url.hostname.toLowerCase();
    if (!OWN_HOSTS.includes(host)) return null;
    return normalizePath(url.pathname);
  } catch {
    return null;
  }
}
