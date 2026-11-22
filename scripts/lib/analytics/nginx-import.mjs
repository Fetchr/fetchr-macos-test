/** Site history from nginx access logs (combined format), for the days before
 * the beacon existed. Produces the same counters the beacon does; addresses
 * and agents are only hashed in memory for the per-day visitor count. */

import { createHash } from "node:crypto";

import { BOT_UA, classifyAgent, normalizePath, referrerHost, sitePageOf } from "./site-hits.mjs";

const LINE = /^(\S+) \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):[^\]]+\] "(\w+) ([^ "]+)[^"]*" (\d{3}) \S+ "([^"]*)" "([^"]*)"/;
const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const NOT_PAGES = /^\/(api|assets|vendor|downloads|admin|rec|review-files|\.well-known)\//;

export function parseLine(line) {
  const match = LINE.exec(line);
  if (!match) return null;
  const [, ip, dd, mon, yyyy, method, target, status, referrer, ua] = match;
  if (!MONTHS[mon]) return null;
  return { ip, day: `${yyyy}-${MONTHS[mon]}-${dd}`, method, target, status: Number(status), referrer: referrer === "-" ? "" : referrer, ua };
}

/** Online downloads the site's widget made, by the page it ran on. */
const GRAB_CALLS = { "/api/grab/info": "grab_info", "/api/grab/jobs": "grab_job" };

const isPage = (path) => !NOT_PAGES.test(path) && (path.endsWith("/") || path.endsWith(".html"));

/** Requests only a browser running the page's scripts makes: the pages call
 *  the API with no-store, and load their scripts, styles and images. */
const RAN_THE_PAGE = /^\/(api\/(?!downloads\/)|assets\/|vendor\/)/;

const visitorKey = (hit) => `${hit.day}|${hit.ip}|${hit.ua}`;

/** Visitors (day, address, agent) whose browser ran the page; the rest are robots. */
export function browsersInLog(hits) {
  return new Set(hits.filter((hit) => hit.status < 400 && RAN_THE_PAGE.test(hit.target)).map(visitorKey));
}

/** `{ day: { key: n } }` for the lines whose day is before `beforeDay`. */
export function countLogLines(lines, { beforeDay }) {
  const days = {};
  const seen = new Set();
  const parsedHits = lines.map(parseLine).filter((hit) => hit && hit.day < beforeDay);
  const browsers = browsersInLog(parsedHits);
  const bump = (day, key, amount = 1) => {
    const counts = (days[day] ||= {});
    counts[key] = (counts[key] || 0) + amount;
  };
  let parsed = 0;
  for (const hit of parsedHits) {
    const grab = hit.method === "POST" && hit.status < 400 ? GRAB_CALLS[hit.target.split("?")[0]] : null;
    if (grab) {
      parsed += 1;
      bump(hit.day, `ev:${grab}`);
      const from = sitePageOf(hit.referrer);
      if (from) bump(hit.day, `evpage:${grab}:${from}`);
      continue;
    }
    if (hit.method !== "GET") continue;
    parsed += 1;
    let url;
    try {
      url = new URL(hit.target, "https://fetchr.fun");
    } catch {
      continue;
    }
    const raw = url.pathname;
    if (/^\/(api\/)?downloads\/fetchr-setup/i.test(raw) && hit.status === 200) {
      bump(hit.day, /mozilla/i.test(hit.ua) ? "dl.site" : "dl.app");
      bump(hit.day, `dl.file:${raw.split("/").pop().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 60)}`);
      const from = /mozilla/i.test(hit.ua) ? sitePageOf(hit.referrer) : null;
      if (from) bump(hit.day, `dlpage:${from}`);
      continue;
    }
    if (hit.status !== 200 || !isPage(raw)) continue;
    if (!hit.ua || BOT_UA.test(hit.ua) || !/mozilla\//i.test(hit.ua)) {
      bump(hit.day, "site.bots");
      bump(hit.day, "bot:agent");
      continue;
    }
    if (!browsers.has(visitorKey(hit))) {
      bump(hit.day, "site.bots");
      bump(hit.day, "bot:no_js");
      continue;
    }
    const path = normalizePath(raw);
    bump(hit.day, "site.pageviews");
    bump(hit.day, `page:${path}`);
    const pageVisitor = createHash("sha256").update(`${hit.day}|${hit.ip}|${hit.ua}|${path}`).digest("base64url").slice(0, 16);
    if (!seen.has(pageVisitor)) {
      seen.add(pageVisitor);
      bump(hit.day, `pagevis:${path}`);
    }
    const visitor = createHash("sha256").update(`${hit.day}|${hit.ip}|${hit.ua}`).digest("base64url").slice(0, 16);
    if (seen.has(visitor)) continue;
    seen.add(visitor);
    const { os, device, browser } = classifyAgent(hit.ua);
    bump(hit.day, "site.visitors");
    bump(hit.day, `entry:${path}`);
    bump(hit.day, `device:${device}`);
    bump(hit.day, `os:${os}`);
    bump(hit.day, `browser:${browser}`);
    const ref = referrerHost(hit.referrer);
    if (ref) bump(hit.day, `ref:${ref}`);
    const source = (url.searchParams.get("utm_source") || url.searchParams.get("ref") || "").toLowerCase();
    if (/^[a-z0-9][a-z0-9_.-]{0,39}$/.test(source)) bump(hit.day, `utm:${source}`);
  }
  return { days, parsed };
}
