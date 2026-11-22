#!/usr/bin/env node
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { createAccount } from "./lib/account.mjs";
import { createAdminAuth } from "./lib/admin-auth.mjs";
import { createWebLoginBox } from "./lib/web-login.mjs";
import { createArchiveTenants } from "./lib/archive-tenants.mjs";
import { createEmotes } from "./lib/emotes.mjs";
import { createErrorTelemetry, ValidationError } from "./lib/error-telemetry.mjs";
import { createGrab } from "./lib/grab.mjs";
import { ClientError } from "./lib/http-errors.mjs";
import { createJobLogs } from "./lib/job-logs.mjs";
import { createLicenseWatch } from "./lib/license-watch.mjs";
import { createRateLimiter } from "./lib/rate-limit.mjs";
import { createRobokassaResult } from "./lib/robokassa-result.mjs";
import { createPayRedirect } from "./lib/pay-redirect.mjs";
import { createSiteCheckout } from "./lib/site-checkout.mjs";
import { createRobokassa } from "./lib/bot/robokassa.mjs";
import { createPseudonymizer } from "./lib/privacy/pseudonym.mjs";
import { createTelemetryEvents, readEvents } from "./lib/telemetry-events.mjs";
import { createAppCounter } from "./lib/analytics/app-counters.mjs";
import { createCounters } from "./lib/analytics/counters.mjs";
import { buildReport } from "./lib/analytics/report.mjs";
import { botDays, botSnapshot, jobLogStatsAsync, mergeDays } from "./lib/analytics/ops-stats.mjs";
import { createSiteHits, sitePageOf } from "./lib/analytics/site-hits.mjs";
import { createServerStats, parseUnits } from "./lib/analytics/server-stats.mjs";
import { publicCatalog } from "./lib/catalog-public.mjs";
import { foldEvents, readAggregates, summarize } from "./lib/telemetry-summary.mjs";

const port = Number(process.env.PORT || 8787);
const dataDir = resolve(process.env.FETCHR_VPS_DATA_DIR || "vps-data");
const downloadsDir = resolve(process.env.FETCHR_VPS_DOWNLOADS_DIR || join(dataDir, "downloads"));
const telemetryPath = join(dataDir, "telemetry.jsonl");
const aggregatesPath = join(dataDir, "telemetry-aggregates.json");
const licensesPath = resolve(process.env.FETCHR_BETA_BOT_LOG || join(dataDir, "beta-bot-licenses.jsonl"));
const updatePath = resolve(process.env.FETCHR_UPDATE_JSON || join(dataDir, "latest-update.json"));
// Reviews are read-only now: the list and the files already uploaded stay public,
// posting and uploading answer 410.
const reviewsPath = resolve(process.env.FETCHR_REVIEWS_JSONL || join(dataDir, "reviews.jsonl"));
const reviewFilesDir = resolve(process.env.FETCHR_REVIEW_FILES_DIR || join(dataDir, "review-files"));
const closedReviewRoutes = new Set(["/reviews", "/reviews/validate-id", "/review-files"]);
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramApiBase = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
const requiredChannel = normalizeChannel(process.env.FETCHR_BETA_REQUIRED_CHANNEL);

mkdirSync(dataDir, { recursive: true });
const pseudonym = createPseudonymizer({
  secret: process.env.FETCHR_REPORTER_HMAC_SECRET || "",
  log: (line) => console.error(line),
});
const errorTelemetry = createErrorTelemetry({
  dataDir,
  adminToken: process.env.ERRORS_ADMIN_TOKEN || "",
  pseudonym,
});
const adminAuth = createAdminAuth({
  adminToken: process.env.ERRORS_ADMIN_TOKEN || "",
  sessionsPath: join(dataDir, "admin-sessions.json"),
  log: (line) => console.error(line),
});
mkdirSync(downloadsDir, { recursive: true });
const jobLogs = createJobLogs({
  dataDir,
  maxBytes: Number(process.env.FETCHR_JOB_LOGS_MAX_MB || 400) * 1024 * 1024,
  retentionDays: Number(process.env.FETCHR_JOB_LOGS_DAYS || 30),
  pseudonym,
});

const telemetryEvents = createTelemetryEvents({
  path: telemetryPath,
  // Aggregates first: events rolled up meanwhile are then still counted once.
  buildSummary: async (events) => summarize(foldEvents(await readAggregates(aggregatesPath), events)),
});

// Admin dashboard counters: counts only, no visitor data (lib/analytics/).
const counters = createCounters({ path: join(dataDir, "analytics-counters.json"), log: (line) => console.error(line) });
const siteHits = createSiteHits({ counters });
const appCounter = createAppCounter(counters);
// Ingest waits for this, so an event is never both in the backfill and counted live.
const appCounterReady = Promise.all([readEvents(telemetryPath), readAggregates(aggregatesPath)])
  .then(([events, aggregates]) => appCounter.start(events, aggregates) && console.log(`analytics: backfilled ${events.length} app events + archive`))
  .catch((err) => console.error(`analytics: backfill failed: ${err.message}`));
const allowAdminMiss = createRateLimiter({ limit: 10, windowMs: 10 * 60_000 });
const allowDownloadCount = createRateLimiter({ limit: 10, windowMs: 10 * 60_000 });
function requireAdmin(req, res) {
  if (adminAuth.isAdmin(req)) return true;
  if (allowAdminMiss(clientIp(req))) json(res, 403, { error: "forbidden" });
  else json(res, 429, { error: "rate_limited" });
  return false;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    try { serverStats?.persist(); } catch { /* best effort */ }
    counters.stop().finally(() => process.exit(0));
  });
}

// Generous on purpose: a 429 here locks the app, and many users can share one VPN exit.
const allowLicenseCheck = createRateLimiter({ limit: 300, windowMs: 10 * 60_000 });
const licenseWatch = createLicenseWatch({
  officialExeHashes: String(process.env.FETCHR_OFFICIAL_EXE_SHA256 || "").split(/[,;\s]+/),
  log: (line) => console.error(line),
});
const grab = createGrab({
  dataDir,
  ytdlp: process.env.FETCHR_YTDLP_PATH || "/opt/fetchr-services/bin/yt-dlp",
  ffmpeg: process.env.FETCHR_FFMPEG_PATH || "",
  cookies: process.env.FETCHR_YTDLP_COOKIES || join(dataDir, "youtube-cookies.txt"),
  autoUpdate: process.env.FETCHR_YTDLP_AUTOUPDATE !== "0",
  log: (line) => console.log(line),
});

const chatEmotes = createEmotes({ log: (line) => console.error(line) });

// Ruble checkout on fetchr.fun/profile/ (the bot sells only for Stars). The
// bot imports site-orders.jsonl and confirms payments from ResultURL records.
const siteCheckout = createSiteCheckout({
  robokassa: createRobokassa({
    login: process.env.FETCHR_ROBOKASSA_LOGIN,
    password1: process.env.FETCHR_ROBOKASSA_PASSWORD1,
    password2: process.env.FETCHR_ROBOKASSA_PASSWORD2,
    test: process.env.FETCHR_ROBOKASSA_TEST === "1",
  }),
  readOrders: () => readJsonLines(resolve(process.env.FETCHR_BOT_ORDERS || join(dataDir, "bot-orders.jsonl"))),
  readSiteOrders: () => readJsonLines(join(dataDir, "site-orders.jsonl")),
  sitePath: join(dataDir, "site-orders.jsonl"),
  allow: createRateLimiter({ limit: 6, windowMs: 10 * 60_000 }),
  log: (line) => console.error(line),
});

const account = createAccount({
  sessionsPath: join(dataDir, "account-sessions.json"),
  readLicenses: () => readJsonLines(licensesPath),
  appendLicense: (record) => appendFile(licensesPath, `${JSON.stringify(record)}\n`, "utf8"),
  readOrders: () => readJsonLines(resolve(process.env.FETCHR_BOT_ORDERS || join(dataDir, "bot-orders.jsonl"))),
  readGrants: readArchiveGrants,
  archiveProxy: (userId, req, res, path) => archiveProxy(userId, req, res, path),
  emotes: (channel) => chatEmotes.forChannel(channel),
  checkout: siteCheckout,
  sendMessage: sendTelegramMessage,
  lookupUser: telegramProfile,
  // Shared with telegram-beta-bot.mjs, which approves «Войти через Telegram».
  webLogins: createWebLoginBox(join(dataDir, "web-logins")),
  botUrl: process.env.FETCHR_BOT_URL || "https://t.me/fetchr_beta_bot",
  log: (line) => console.error(line),
});

// Archive VPS: buyers' recorders live on the storage server, managed over SSH
// with a key whose forced command is fetchr-tenant. Off when not configured.
const archiveSsh = process.env.FETCHR_ARCHIVE_SSH || "";
const archive = archiveSsh
  ? createArchiveTenants({
      statePath: join(dataDir, "archive-tenants.json"),
      readLicenses: () => readJsonLines(licensesPath),
      readOrders: () => readJsonLines(resolve(process.env.FETCHR_BOT_ORDERS || join(dataDir, "bot-orders.jsonl"))),
      // Hand-issued plans: [{ machine_id | telegram_user_id, plan, quota_gb, channels, packs?, until?, note? }]
      readGrants: readArchiveGrants,
      provision: (args) => storageCommand(args),
      publicBase: process.env.FETCHR_ARCHIVE_PUBLIC_BASE || "https://fetchr.fun/rec",
      log: (line) => console.error(line),
    })
  : null;
if (archive) {
  const tick = () => archive.reconcile().catch((err) => console.error(`archive: reconcile failed: ${err.message}`));
  tick();
  setInterval(tick, 60_000).unref();
}

// Server health for /admin/: only where there is a /proc to read (Linux).
const adminDisks = String(process.env.FETCHR_ADMIN_DISKS || "/,/srv").split(",").map((m) => m.trim()).filter(Boolean);
const serverStats = existsSync("/proc/stat")
  ? createServerStats({
      statePath: join(dataDir, "server-stats.json"),
      disks: adminDisks.length ? adminDisks : ["/", "/srv"],
      // Recorder ids kept off the dashboard's tables (e.g. our own), comma-separated.
      hidden: String(process.env.FETCHR_ADMIN_HIDDEN_TENANTS || "").split(",").map((id) => id.trim()).filter(Boolean),
      log: (line) => console.error(line),
    })
  : null;
serverStats?.start();

// The site's Archive VPS page -> this user's recorder, over the storage tunnel.
// When FETCHR_ARCHIVE_DIRECT_BASE is set (e.g. https://archive.fetchr.fun/rec),
// heavy read-only media routes redirect straight to the storage host so video
// bytes never transit the RU account VPS.
const ARCHIVE_DIRECT_BASE = (process.env.FETCHR_ARCHIVE_DIRECT_BASE || "").replace(/\/+$/, "");
const ARCHIVE_DIRECT_MEDIA_RE = /^\/(?:recordings\/[^/?#]+\/(?:playlist\.m3u8|segments\/[^/?#]+|poster\.jpg|peaks|chat\.json)|clips\/[^/?#]+\/(?:video\.mp4|poster\.jpg|chat\.json))(?:[?#]|$)/;
const ARCHIVE_REQUEST_HEADERS = ["content-type", "content-length", "range", "accept", "if-range"];
const ARCHIVE_RESPONSE_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "last-modified", "etag"];
function archiveProxy(userId, req, res, path) {
  const tenant = archive?.tenantOf(userId);
  if (!tenant) {
    return json(res, 404, { error: "no_archive", message: "Архив ещё создаётся — обновите страницу через минуту." });
  }
  if (!path.startsWith("/") || path.startsWith("/speedtest") || path.includes("..")) {
    return json(res, 404, { error: "not_found" });
  }
  if (ARCHIVE_DIRECT_BASE && (req.method === "GET" || req.method === "HEAD") && ARCHIVE_DIRECT_MEDIA_RE.test(path)) {
    const sep = path.includes("?") ? "&" : "?";
    const location = `${ARCHIVE_DIRECT_BASE}/${encodeURIComponent(tenant.id)}${path}${sep}token=${encodeURIComponent(tenant.token)}`;
    res.writeHead(307, {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    res.end();
    return Promise.resolve();
  }
  return new Promise((done) => {
    const headers = { "x-token": tenant.token };
    for (const name of ARCHIVE_REQUEST_HEADERS) if (req.headers[name]) headers[name] = req.headers[name];
    const upstream = httpRequest({ host: "127.0.0.1", port: 8480, method: req.method, path: `/t/${tenant.id}${path}`, headers, timeout: 1_900_000 }, (up) => {
      const out = { "x-content-type-options": "nosniff" };
      for (const name of ARCHIVE_RESPONSE_HEADERS) if (up.headers[name]) out[name] = up.headers[name];
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
      up.on("end", done);
      up.on("error", done);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) json(res, 502, { error: "storage_unavailable", message: "Сервер архива недоступен, попробуйте через минуту." });
      else res.destroy();
      done();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
}

// Hand-issued Archive VPS plans: [{ machine_id | telegram_user_id, plan, quota_gb, channels, packs?, until?, note? }]
async function readArchiveGrants() {
  try {
    return JSON.parse(await readFile(join(dataDir, "archive-grants.json"), "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`archive: grants unreadable: ${err.message}`);
    return [];
  }
}

function storageCommand(args) {
  const sshArgs = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    ...(process.env.FETCHR_ARCHIVE_SSH_KEY ? ["-i", process.env.FETCHR_ARCHIVE_SSH_KEY] : []),
    archiveSsh,
    ["fetchr-tenant", ...args].join(" "),
  ];
  return new Promise((resolvePromise) => {
    execFile("ssh", sshArgs, { timeout: 90_000 }, (err, stdout) => {
      try {
        resolvePromise(JSON.parse(String(stdout).trim().split("\n").at(-1)));
      } catch {
        resolvePromise({ ok: false, error: err ? err.message : "unparseable answer" });
      }
    });
  });
}

// Robokassa ResultURL: https://fetchr.fun/api/robokassa/result. The bot reads
// robokassa-payments.jsonl to confirm orders.
const robokassa = createRobokassaResult({
  login: process.env.FETCHR_ROBOKASSA_LOGIN,
  password1: process.env.FETCHR_ROBOKASSA_PASSWORD1,
  password2: process.env.FETCHR_ROBOKASSA_PASSWORD2,
  test: process.env.FETCHR_ROBOKASSA_TEST === "1",
  paymentsPath: join(dataDir, "robokassa-payments.jsonl"),
  botUrl: process.env.FETCHR_BOT_URL || "https://t.me/fetchr_beta_bot",
  log: (line) => console.error(line),
});

// Payment links: https://fetchr.fun/api/pay/<token> → the order's Robokassa page.
// The bot reads pay-clicks.jsonl to remind only those who opened it.
const payRedirect = createPayRedirect({
  readOrders: () => readJsonLines(resolve(process.env.FETCHR_BOT_ORDERS || join(dataDir, "bot-orders.jsonl"))),
  clicksPath: join(dataDir, "pay-clicks.jsonl"),
  botUrl: process.env.FETCHR_BOT_URL || "https://t.me/fetchr_beta_bot",
  allow: createRateLimiter({ limit: 30, windowMs: 10 * 60_000 }),
  log: (line) => console.error(line),
});

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    if (await grab.handle(req, res, url, { json, readJson })) return;
    if (await account.handle(req, res, url, { json, readJson })) return;
    if (archive && await archive.handle(req, res, url, { json, readJson })) return;
    if (await robokassa.handle(req, res, url)) return;
    if (await payRedirect.handle(req, res, url, clientIp(req))) return;

    if (req.method === "POST" && url.pathname === "/telemetry/events") {
      const body = await readJson(req, 32 * 1024);
      await appCounterReady;
      const result = await telemetryEvents.ingest(body, clientIp(req), appCounter.count);
      return json(res, result.status, result.body);
    }

    if (req.method === "GET" && url.pathname === "/catalog") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" });
      return res.end(JSON.stringify(publicCatalog()));
    }

    if (req.method === "POST" && url.pathname === "/analytics/hit") {
      const status = siteHits.ingest(await readJson(req, 4 * 1024), { ip: clientIp(req), ua: String(req.headers["user-agent"] || ""), headers: req.headers });
      res.writeHead(status, { "Cache-Control": "no-store" });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/admin/login") {
      const body = await readJson(req, 4 * 1024);
      const token = typeof body?.token === "string" ? body.token.trim() : "";
      if (!adminAuth.isTokenValid(token)) {
        return allowAdminMiss(clientIp(req)) ? json(res, 403, { error: "forbidden" }) : json(res, 429, { error: "rate_limited" });
      }
      const cookie = adminAuth.createSession(req, { remember: Boolean(body?.remember) });
      return json(res, 200, { ok: true }, { "Set-Cookie": cookie });
    }

    if (req.method === "POST" && url.pathname === "/admin/logout") {
      const cookie = adminAuth.destroySession(req);
      return json(res, 200, { ok: true }, { "Set-Cookie": cookie });
    }

    if (req.method === "GET" && url.pathname === "/admin/session") {
      return json(res, 200, { ok: adminAuth.isAdmin(req) });
    }

    if (req.method === "GET" && url.pathname === "/admin/analytics") {
      if (!requireAdmin(req, res)) return;
      const days = clampNumber(url.searchParams.get("days"), 1, 365, 30);
      const fresh = url.searchParams.get("fresh") === "1";
      return json(res, 200, await adminReport(days, { fresh }));
    }

    if (req.method === "GET" && url.pathname === "/admin/server") {
      if (!requireAdmin(req, res)) return;
      const remoteUrl = (process.env.FETCHR_SERVER_STATS_URL || "").trim();
      if (remoteUrl) {
        try {
          const [remoteRes, localUnits] = await Promise.all([
            fetch(remoteUrl, { signal: AbortSignal.timeout(15_000) }),
            new Promise((done) => {
              execFile(
                "systemctl",
                ["show", "-p", "Id", "-p", "ActiveState", "-p", "SubState", "fetchr-api", "fetchr-telegram-bot", "fetchr-data-cleanup.timer", "fetchr-cert-renew.timer"],
                { timeout: 5000 },
                (err, stdout) => done(err ? [] : parseUnits(stdout)),
              );
            }),
          ]);
          if (!remoteRes.ok) return json(res, 502, { error: "storage_stats_failed", status: remoteRes.status });
          const data = await remoteRes.json();
          const merged = new Map();
          for (const u of [...localUnits, ...(Array.isArray(data.services) ? data.services : [])]) {
            if (u?.name) merged.set(u.name, u);
          }
          data.services = [...merged.values()];
          return json(res, 200, data);
        } catch (err) {
          console.error(`admin/server remote failed: ${err instanceof Error ? err.message : err}`);
          return json(res, 502, { error: "storage_stats_unavailable" });
        }
      }
      if (!serverStats) return json(res, 404, { error: "not_available" });
      return json(res, 200, await serverStats.snapshot());
    }

    if (req.method === "GET" && url.pathname === "/telemetry/summary") {
      return json(res, 200, await telemetryEvents.summary());
    }

    if (url.pathname === "/telemetry/job-logs" && req.method === "HEAD") {
      // Lets the client check the certificate pin before it sends a log.
      res.writeHead(204, { "Cache-Control": "no-store" });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/telemetry/job-logs") {
      let body;
      try {
        body = await readMaybeGzippedJson(req, 3 * 1024 * 1024, 4 * 1024 * 1024);
      } catch (err) {
        if (err instanceof ClientError) throw err;
        return json(res, 400, { error: "bad_request" });
      }
      const result = await jobLogs.ingest(body, clientIp(req));
      return json(res, result.status, result.body);
    }

    if (req.method === "GET" && url.pathname.startsWith("/telemetry/job-logs")) {
      if (!requireAdmin(req, res)) return;
      if (url.pathname === "/telemetry/job-logs") {
        return json(res, 200, await jobLogs.list({
          day: url.searchParams.get("day") || "",
          status: url.searchParams.get("status") || "",
          machine: url.searchParams.get("machine") || "",
          kind: url.searchParams.get("kind") || "",
          limit: clampNumber(url.searchParams.get("limit"), 1, 1000, 100),
        }));
      }
      if (url.pathname === "/telemetry/job-logs/file") {
        const text = await jobLogs.read(url.searchParams.get("path"));
        if (text === null) return json(res, 404, { error: "not_found" });
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(text);
      }
      return json(res, 404, { error: "not_found" });
    }

    if (url.pathname === "/telemetry/errors" && req.method === "HEAD") {
      // Lets the client check the certificate pin before it sends a body.
      res.writeHead(204, { "Cache-Control": "no-store" });
      return res.end();
    }

    if (url.pathname.startsWith("/telemetry/errors")) {
      try {
        if (req.method === "POST" && url.pathname === "/telemetry/errors") {
          const result = await errorTelemetry.ingest(await readJson(req, 512 * 1024), clientIp(req));
          return json(res, result.status, result.body);
        }
        if (!requireAdmin(req, res)) return;
        if (req.method === "GET" && url.pathname === "/telemetry/errors") {
          const status = url.searchParams.get("status") || "";
          const limit = clampNumber(url.searchParams.get("limit"), 1, 500, 50);
          return json(res, 200, await errorTelemetry.groups({ status, limit }));
        }
        if (req.method === "GET" && url.pathname === "/telemetry/errors/group") {
          return json(res, 200, await errorTelemetry.samples(url.searchParams.get("fingerprint") || ""));
        }
        if (req.method === "POST" && url.pathname === "/telemetry/errors/name") {
          return json(res, 200, await errorTelemetry.name(await readJson(req)));
        }
        return json(res, 404, { error: "not_found" });
      } catch (err) {
        // Only a bad request is the client's fault; a client drops a batch
        // on 4xx but retries on 5xx, so server trouble must not look like 400.
        const invalid = err instanceof ValidationError || err instanceof SyntaxError
          || String(err?.message || "").includes("request body too large");
        return json(res, invalid ? 400 : 500, { error: invalid ? String(err.message) : "internal_error" });
      }
    }

    if (req.method === "POST" && url.pathname === "/license/status") {
      const ip = clientIp(req);
      if (!allowLicenseCheck(ip)) return json(res, 429, { error: "rate_limited" });
      const request = await readJson(req, 16 * 1024);
      validateLicenseStatusRequest(request);
      licenseWatch.observe(request, ip);
      return json(res, 200, await licenseStatus(request));
    }

    if (req.method === "GET" && url.pathname === "/reviews") {
      return json(res, 410, { error: "reviews_closed" });
    }

    if (req.method === "POST" && closedReviewRoutes.has(url.pathname)) {
      return json(res, 410, { error: "reviews_closed" });
    }

    if (req.method === "GET" && url.pathname === "/updates/latest") {
      const currentVersion = url.searchParams.get("current_version") || "0.0.0";
      return json(res, 200, latestUpdate(currentVersion));
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/downloads/")) {
      return serveDownload(req, res, decodeURIComponent(url.pathname.slice("/downloads/".length)), req.method === "HEAD");
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/review-files/")) {
      return json(res, 410, { error: "reviews_closed" });
    }

    json(res, 404, { error: "not_found" });
  } catch (err) {
    respondError(res, err);
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Fetchr VPS API listening on http://127.0.0.1:${port}`);
});

/** nginx sets X-Real-IP on every proxied location; direct access is firewalled. */
function clientIp(req) {
  return String(req.headers["x-real-ip"] || req.socket.remoteAddress || "");
}

/** Client mistakes get their own status; anything else is logged and answered
 *  with a bare 500, so paths and internals never reach the response. */
function respondError(res, err) {
  if (res.headersSent) return res.destroy();
  if (err instanceof ClientError) return json(res, err.status, { error: err.message });
  if (err instanceof SyntaxError || err instanceof URIError) return json(res, 400, { error: "bad_request" });
  console.error(`api: ${err instanceof Error ? err.stack || err.message : err}`);
  return json(res, 500, { error: "internal_error" });
}

async function licenseStatus(request) {
  const machineId = request.machine_id.toUpperCase();
  const key = normalizeLicenseKey(request.license_key);
  const issued = (await readJsonLines(licensesPath))
    .filter((record) => String(record.machine_id || "").toUpperCase() === machineId)
    .reverse()
    .find((record) => normalizeLicenseKey(record.license_key) === key);

  if (!issued) {
    return {
      active: false,
      reason: "not_issued",
      message: "Ключ не найден в списке выданных beta-доступов.",
    };
  }

  if (issued.revoked_at) {
    return {
      active: false,
      reason: "revoked",
      message: issued.revoked_by === "release"
        ? "Для этой версии нужен новый ключ: обновите приложение и получите ключ в Telegram-боте."
        : "Beta-доступ отозван.",
    };
  }

  if (!requiredChannel) {
    return {
      active: true,
      reason: "subscription_check_not_configured",
      runtime_config: runtimeConfig(),
      message: "Проверка подписки на сервере еще не настроена.",
    };
  }

  if (!telegramToken) {
    return {
      active: false,
      reason: "telegram_not_configured",
      message: "Сервер не настроен для проверки Telegram-подписки.",
    };
  }

  const subscription = await checkTelegramSubscription(requiredChannel, issued.telegram_user_id);
  if (!subscription.ok) {
    return {
      active: false,
      reason: subscription.setupError ? "subscription_check_failed" : "subscription_required",
      message: subscription.setupError
        ? "Сервер временно не смог проверить подписку."
        : "Подписка на Telegram-канал обязательна для beta-доступа.",
    };
  }

  return {
    active: true,
    reason: "ok",
    message: null,
    runtime_config: runtimeConfig(),
  };
}

function runtimeConfig() {
  return {
    product: "fetchr-beta",
    channel: "beta",
    features: [
      "license_gate",
      "queue",
      "m3u8_finder",
      "chat_render",
      "sponsor_blur",
      "updates",
      "telemetry",
    ],
    lease_expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
  };
}

async function publicReviews(limit = 10) {
  const reviews = await readJsonLines(reviewsPath);
  const selected = reviews
    .filter((review) => review && review.published !== false)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, limit);
  return selected.map(publicReview);
}

/** No network here: the server never fetches a URL a visitor typed in. */
function publicReview(review) {
  const avatarUrl = review.avatar_url || telegramAvatarFromProfile(review.telegram_url || review.profile_url);
  return {
    id: review.id,
    created_at: review.created_at,
    display_name: review.display_name,
    project_username: review.project_username,
    contact_url: review.contact_url,
    pros: review.pros,
    cons: review.cons,
    experience: review.experience,
    rating: review.rating,
    text: review.text,
    profile_url: review.profile_url,
    telegram_url: review.telegram_url,
    youtube_url: review.youtube_url,
    discord_url: review.discord_url,
    proof_url: review.proof_url,
    avatar_url: avatarUrl,
    allow_profile: Boolean(review.allow_profile),
    usage_started_at: review.usage_started_at,
    usage_label: usageLabel(review.usage_started_at),
  };
}

function latestUpdate(currentVersion) {
  const update = readUpdateConfig();
  if (!update.version || !update.installer_url) {
    return { available: false, version: currentVersion };
  }
  return {
    ...update,
    available: update.available ?? versionIsNewer(update.version, currentVersion),
  };
}

function readUpdateConfig() {
  if (existsSync(updatePath)) {
    return JSON.parse(readFileSync(updatePath, "utf8"));
  }

  const version = process.env.FETCHR_UPDATE_VERSION || "";
  const file = process.env.FETCHR_UPDATE_FILE || "";
  const installerUrl =
    process.env.FETCHR_UPDATE_INSTALLER_URL ||
    (file ? `/downloads/${encodeURIComponent(basename(file))}` : "");

  return {
    version,
    installer_url: installerUrl,
    installer_sha256: process.env.FETCHR_UPDATE_SHA256 || "",
    notes: process.env.FETCHR_UPDATE_NOTES || "",
    published_at: process.env.FETCHR_UPDATE_PUBLISHED_AT || new Date().toISOString(),
  };
}

/** Bot logs and job-log folders are read at most every few minutes. */
let opsCache = { at: 0, value: null };
async function opsFigures({ fresh = false } = {}) {
  if (!fresh && opsCache.value && Date.now() - opsCache.at < 5 * 60_000) return opsCache.value;
  const botDir = resolve(process.env.FETCHR_BOT_DATA_DIR || dataDir);
  const [botOrders, siteOrders, licenses, activity, consents, channel, followUps, jobs] = await Promise.all([
    readJsonLines(resolve(process.env.FETCHR_BOT_ORDERS || join(botDir, "bot-orders.jsonl"))),
    readJsonLines(join(dataDir, "site-orders.jsonl")),
    readJsonLines(licensesPath),
    readJsonLines(join(botDir, "bot-activity.jsonl")),
    readJsonLines(join(botDir, "bot-consents.jsonl")),
    readJsonLines(join(botDir, "channel-members.jsonl")),
    readJsonLines(join(botDir, "bot-followups.jsonl")),
    jobLogStatsAsync(join(dataDir, "job-logs")),
  ]);
  const knownBotIds = new Set(botOrders.map((order) => order?.id).filter(Boolean));
  const orders = [...botOrders, ...siteOrders.filter((order) => order?.id && !knownBotIds.has(order.id))];
  const value = {
    days: mergeDays(botDays({ activity, consents, licenses, orders, followUps }), jobs.days),
    gauges: { "tg.members": Object.fromEntries(channel.filter((row) => row?.day && Number.isInteger(row.members)).map((row) => [row.day, row.members])) },
    bot: botSnapshot({ activity, consents, licenses, orders }),
    jobs: jobs.snapshot,
  };
  opsCache = { at: Date.now(), value };
  return value;
}

async function adminReport(days, { fresh = false } = {}) {
  const [ops, errors] = await Promise.all([
    opsFigures({ fresh }),
    errorTelemetry.groups({ status: "open", limit: 25 }).catch(() => ({ groups: [] })),
  ]);
  const allTime = await telemetryEvents.summary().catch(() => null);
  return buildReport({
    counters,
    days,
    allTime: allTime && {
      devices: allTime.app_unique_devices,
      launches: allTime.app_launches,
      downloads: allTime.downloaded_streams,
      hours: allTime.downloaded_hours,
      bytes: allTime.downloaded_bytes,
      last_7d: allTime.downloads_last_7d,
      versions: allTime.app_devices_by_version,
      platforms: allTime.stream_downloads_by_platform,
    },
    business: ops.days,
    snapshots: { bot: ops.bot, jobs: ops.jobs },
    gauges: ops.gauges,
    errors: (errors.groups || []).map(({ fingerprint, name, status, fixed_in, note, code, source, level, message, occurrences, machines, versions, first_seen, last_seen }) => ({
      fingerprint, name, status, fixed_in, note, code, source, level, message: String(message || "").slice(0, 200), occurrences, machines, versions, first_seen, last_seen,
    })),
  });
}

/** A browser counts as a site download; the app's updater sends its own agent.
 *  Resumed parts (Range past byte 0) are the same download, not a new one. */
function countDownload(req, name) {
  if (req.method !== "GET") return;
  const range = String(req.headers.range || "");
  if (range && !/^bytes=0-/.test(range)) return;
  if (!allowDownloadCount(clientIp(req))) return;
  const browser = /mozilla/i.test(String(req.headers["user-agent"] || ""));
  counters.bump(browser ? "dl.site" : "dl.app");
  counters.bump(`dl.file:${name.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 60)}`);
  const from = sitePageOf(req.headers.referer);
  if (browser && from) counters.bump(`dlpage:${from}`);
}

function serveDownload(req, res, name, headOnly = false) {
  const safeName = basename(name);
  const path = resolve(downloadsDir, safeName);
  if (!path.startsWith(downloadsDir) || !existsSync(path)) {
    return json(res, 404, { error: "download_not_found" });
  }

  countDownload(req, safeName);
  const meta = statSync(path);
  res.writeHead(200, {
    "Content-Type": contentType(path),
    "Content-Length": String(meta.size),
    "Content-Disposition": `attachment; filename="${safeName.replaceAll('"', "")}"`,
  });
  if (headOnly) return res.end();
  createReadStream(path).pipe(res);
}

function serveReviewFile(res, name, headOnly = false) {
  const safeName = basename(name);
  const path = resolve(reviewFilesDir, safeName);
  if (!path.startsWith(reviewFilesDir) || !existsSync(path)) {
    return json(res, 404, { error: "review_file_not_found" });
  }

  const meta = statSync(path);
  res.writeHead(200, {
    "Content-Type": contentType(path),
    "Content-Length": String(meta.size),
    "Cache-Control": "public, max-age=31536000, immutable",
    // Visitors uploaded these bytes: never let a browser run them as a page.
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  if (headOnly) return res.end();
  createReadStream(path).pipe(res);
}

function validateLicenseStatusRequest(request) {
  if (!request || typeof request !== "object") throw new ClientError(400, "request must be an object");
  if (typeof request.machine_id !== "string" || !/^[A-F0-9]{32}$/i.test(request.machine_id)) {
    throw new ClientError(400, "invalid machine_id");
  }
  if (typeof request.license_key !== "string" || !request.license_key.trim()) {
    throw new ClientError(400, "invalid license_key");
  }
}

async function readJson(req, maxBytes = 256 * 1024) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxBytes) throw new ClientError(413, "request body too large");
  }
  return JSON.parse(body || "{}");
}

/** JSON body that may be gzipped (`Content-Encoding: gzip`); both sizes are capped. */
async function readMaybeGzippedJson(req, maxBytes, maxUnpackedBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ClientError(413, "request body too large");
    chunks.push(chunk);
  }
  let raw = Buffer.concat(chunks);
  if (String(req.headers["content-encoding"] || "").toLowerCase() === "gzip") {
    try {
      raw = gunzipSync(raw, { maxOutputLength: maxUnpackedBytes });
    } catch {
      throw new ClientError(413, "request body too large or not gzip");
    }
  }
  return JSON.parse(raw.toString("utf8") || "{}");
}

async function readJsonLines(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeLicenseKey(value) {
  return String(value || "").replace(/\s+/g, "");
}

function telegramAvatarFromProfile(source) {
  try {
    const url = new URL(source);
    if (/(^|\.)t\.me$/i.test(url.hostname) || /(^|\.)telegram\.me$/i.test(url.hostname)) {
      const username = url.pathname.split("/").filter(Boolean)[0];
      if (username) return `https://t.me/i/userpic/320/${encodeURIComponent(username)}.jpg`;
    }
  } catch {
    return "";
  }
  return "";
}

function usageLabel(value) {
  const started = Date.parse(value || "");
  if (!Number.isFinite(started)) return "срок пользования подтверждается";
  const days = Math.max(0, Math.floor((Date.now() - started) / 86_400_000));
  if (days === 0) return "пользуется сегодня";
  if (days === 1) return "пользуется 1 день";
  if (days < 30) return `пользуется ${days} ${pluralRu(days, "день", "дня", "дней")}`;
  const months = Math.floor(days / 30);
  const restDays = days % 30;
  if (restDays === 0) return `пользуется ${months} ${pluralRu(months, "месяц", "месяца", "месяцев")}`;
  return `пользуется ${months} ${pluralRu(months, "месяц", "месяца", "месяцев")} ${restDays} ${pluralRu(restDays, "день", "дня", "дней")}`;
}

function pluralRu(value, one, few, many) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function normalizeChannel(value) {
  const channel = String(value || "").trim();
  if (!channel) return "";
  if (channel.startsWith("-100")) return channel;
  return channel.startsWith("@") ? channel : `@${channel}`;
}

async function sendTelegramMessage(chatId, text) {
  if (!telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const response = await fetch(`${telegramApiBase}/bot${telegramToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(`sendMessage ${response.status}: ${payload.description || "failed"}`);
}

/** Name and username are read from Telegram when needed and never stored. */
async function telegramProfile(userId) {
  if (!telegramToken) return null;
  const response = await fetch(`${telegramApiBase}/bot${telegramToken}/getChat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: userId }),
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json().catch(() => ({}));
  return response.ok && payload.ok ? payload.result : null;
}

async function checkTelegramSubscription(channel, userId) {
  if (!userId) return { ok: false, setupError: false };
  try {
    const response = await fetch(`${telegramApiBase}/bot${telegramToken}/getChatMember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channel,
        user_id: userId,
      }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      return { ok: false, setupError: true };
    }
    const status = payload.result?.status;
    if (["creator", "administrator", "member"].includes(status)) {
      return { ok: true, setupError: false };
    }
    if (status === "restricted" && payload.result?.is_member) {
      return { ok: true, setupError: false };
    }
    return { ok: false, setupError: false };
  } catch {
    return { ok: false, setupError: true };
  }
}

function versionIsNewer(candidate, current) {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] || 0;
    const b = right[index] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

function parseVersion(value) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function contentType(path) {
  switch (extname(path).toLowerCase()) {
    case ".exe": return "application/vnd.microsoft.portable-executable";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".mov": return "video/quicktime";
    default: return "application/octet-stream";
  }
}

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}
