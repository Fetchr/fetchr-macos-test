import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSource } from "./grab-sources.mjs";
import {
  buildOptions, buildSubtitles, explainFailure, formatSelector, isSubtitleQ, parseSection, safeFilename, sortArgs, subtitleArgs,
} from "./grab.mjs";

const url = (raw) => resolveSource(raw).url;

test("resolveSource rebuilds canonical URLs for every platform", () => {
  assert.equal(url("https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=95"), "https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  assert.equal(url("youtu.be/aqz-KE-bpKQ?si=x"), "https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  assert.equal(url("https://m.youtube.com/shorts/aqz-KE-bpKQ"), "https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  assert.equal(url("https://vk.com/video-77521_162222515"), "https://vk.com/video-77521_162222515");
  assert.equal(url("https://vkvideo.ru/video-77521_162222515?list=x"), "https://vk.com/video-77521_162222515");
  assert.equal(url("https://vk.com/feed?z=video-77521_162222515%2Fpl"), "https://vk.com/video-77521_162222515");
  assert.equal(url("https://soundcloud.com/forss/flickermood?in=x"), "https://soundcloud.com/forss/flickermood");
  assert.equal(url("https://www.twitch.tv/videos/2882031408?t=1h"), "https://www.twitch.tv/videos/2882031408");
  assert.equal(url("https://www.twitch.tv/xqc/clip/Funny-Clip-abc123"), "https://clips.twitch.tv/Funny-Clip-abc123");
  assert.equal(url("https://kick.com/xqc/videos/b5aa076c-1389-4f4e-8f36-acbe2b6eeabd"), "https://kick.com/xqc/videos/b5aa076c-1389-4f4e-8f36-acbe2b6eeabd");
  assert.equal(resolveSource("https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=1").platform, "spotify");
});

test("resolveSource handles TikTok links", () => {
  assert.equal(url("https://www.tiktok.com/@scout2015/video/6718335390845095173?is_from_webapp=1"), "https://www.tiktok.com/@scout2015/video/6718335390845095173");
  assert.equal(url("https://www.tiktok.com/@/video/7440114099565972791?_r=1&_d=x"), "https://www.tiktok.com/@/video/7440114099565972791");
  assert.equal(url("https://m.tiktok.com/v/6718335390845095173.html"), "https://www.tiktok.com/@/video/6718335390845095173");
  assert.deepEqual(resolveSource("https://vm.tiktok.com/ZMe1V4c5P/"), { platform: "tiktok", id: "short:ZMe1V4c5P", url: "https://vm.tiktok.com/ZMe1V4c5P/", short: true });
  assert.equal(url("https://www.tiktok.com/t/ZTRabc123/"), "https://vm.tiktok.com/ZTRabc123/");
  for (const raw of [
    "https://www.tiktok.com/@scout2015",
    "https://www.tiktok.com/@scout2015/photo/6718335390845095173",
    "https://www.tiktok.com.evil.com/@a/video/6718335390845095173",
    "https://vm.tiktok.com/../x",
    "https://www.instagram.com/reel/Chunk8-jurw/",
  ]) {
    assert.ok(resolveSource(raw).error, raw);
  }
});

test("resolveSource rejects lookalikes, channels and other hosts", () => {
  for (const raw of [
    "https://youtube.com.evil.com/watch?v=aqz-KE-bpKQ",
    "https://www.youtube.com/@fetchr",
    "https://www.youtube.com/playlist?list=PL123",
    "https://soundcloud.com/forss/sets/album",
    "https://www.twitch.tv/xqc",
    "https://kick.com/xqc",
    "http://127.0.0.1:8787/grab/info",
    "file:///etc/passwd",
    "https://youtu.be/--exec=rm",
  ]) {
    assert.ok(resolveSource(raw).error, raw);
  }
});

test("resolveSource treats plain text as a search only when asked", () => {
  assert.deepEqual(resolveSource("Rick Astley Never Gonna", { allowQuery: true }), { query: "Rick Astley Never Gonna" });
  assert.ok(resolveSource("Rick Astley Never Gonna").error);
});

test("formatSelector caps online video at 1080p", () => {
  assert.match(formatSelector("1080"), /^bv\*\[height<=1080\]\[vcodec\^=avc1\]\+ba\[ext=m4a\]/);
  assert.match(formatSelector("720", "twitch"), /^b\[height<=720\]/);
  assert.equal(formatSelector("audio"), "ba[ext=m4a]/ba");
  assert.equal(formatSelector("audio", "soundcloud"), "ba[ext=mp3]/ba");
  assert.throws(() => formatSelector("2160"), /Недоступное качество/);
  assert.throws(() => formatSelector("1080; rm -rf /"), /Недоступное качество/);
});

test("buildOptions marks 1440p and 4K as app-only", () => {
  const options = buildOptions({
    duration: 600,
    formats: [
      { vcodec: "none", acodec: "mp4a.40.2", ext: "m4a", abr: 129, filesize: 10e6 },
      { vcodec: "avc1.64002a", acodec: "none", height: 1080, fps: 60, filesize: 245e6 },
      { vcodec: "av01.0.08M.08", acodec: "none", height: 1080, fps: 60, filesize: 150e6 },
      { vcodec: "avc1.4d400c", acodec: "none", height: 144, fps: 30, filesize: 5e6 },
      { vcodec: "avc1.4d401f", acodec: "none", height: 480, fps: 30, filesize: 27e6 },
      { vcodec: "av01.0.13M.08", acodec: "none", height: 2160, fps: 60, filesize: 680e6 },
    ],
  });
  assert.deepEqual(options.map((o) => o.label), ["480p", "1080p60", "4K60", "Звук M4A"]);
  const hd = options.find((o) => o.label === "1080p60");
  assert.equal(hd.q, "1080");
  assert.equal(hd.bytes, 255e6, "size comes from the H.264 rendition plus audio");
  const uhd = options.find((o) => o.label === "4K60");
  assert.equal(uhd.q, null);
  assert.equal(uhd.online, false);
});

test("buildOptions handles audio-only and muxed sources", () => {
  const sc = buildOptions({ duration: 214, formats: [{ vcodec: "none", acodec: "mp3", ext: "mp3", abr: 128 }] });
  assert.deepEqual(sc.map((o) => o.label), ["Звук MP3"]);
  const kick = buildOptions({ formats: [{ vcodec: "avc1", acodec: "mp4a", height: 720 }] });
  assert.deepEqual(kick.map((o) => [o.q, o.online]), [["720", true]]);
  const clip = buildOptions({ formats: [{ format_id: "portrait-900", height: 900 }, { format_id: "720", height: 720 }, { format_id: "1080", height: 1080 }] });
  assert.deepEqual(clip.map((o) => o.q), ["720", "1080"]);
  const old = buildOptions({ duration: 19, formats: [{ vcodec: "avc1", acodec: "mp4a", height: 240, filesize: 7e5 }] });
  assert.deepEqual(old.map((o) => o.q), ["240"]);
});

test("resolveSource handles Rutube and Pinterest links", () => {
  assert.equal(url("https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/?r=wd"), "https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/");
  assert.equal(url("https://rutube.ru/shorts/c6cc4d620b1d4338901770a44b3e82f4/"), "https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/");
  assert.equal(url("https://ru.pinterest.com/pin/664281013778109217/"), "https://www.pinterest.com/pin/664281013778109217/");
  assert.equal(url("https://www.pinterest.ru/pin/origami-crane--664281013778109217/"), "https://www.pinterest.com/pin/664281013778109217/");
  assert.equal(resolveSource("https://pin.it/3xYzAbC").short, true);
  for (const raw of [
    "https://rutube.ru/channel/123/",
    "https://rutube.ru/video/private/c6cc4d620b1d4338901770a44b3e82f4/",
    "https://www.pinterest.com/someone/boards/",
    "https://pinterest.com.evil.com/pin/664281013778109217/",
  ]) {
    assert.ok(resolveSource(raw).error, raw);
  }
});

test("TikTok: short side is the quality, the watermark never", () => {
  assert.equal(formatSelector("720", "tiktok"), "b[format_note!*=?watermark]/bv*[format_note!*=?watermark]+ba/bv*[format_note!*=?watermark]");
  assert.deepEqual(sortArgs("720", "tiktok"), ["-S", "res:720,vcodec:h264,acodec:aac"]);
  assert.deepEqual(sortArgs("audio", "tiktok"), []);
  assert.deepEqual(sortArgs("720", "youtube"), []);
  const options = buildOptions({
    duration: 10,
    formats: [
      { vcodec: "none", acodec: "mp3", ext: "mp3" },
      { vcodec: "h264", acodec: "aac", width: 576, height: 1024, filesize: 1.8e6 },
      { vcodec: "h265", acodec: "aac", width: 720, height: 1280, filesize: 2e6 },
      { vcodec: "h264", acodec: "aac", width: 1080, height: 1920, filesize: 9e6, format_note: "Download video, watermarked" },
    ],
  }, "tiktok");
  assert.deepEqual(options.map((o) => [o.q, o.online]), [["480", true], ["720", true], ["audio", true]]);
});

test("buildSubtitles lists uploaded tracks first, then a few auto captions", () => {
  const subs = buildSubtitles({
    subtitles: { de: [{}], ru: [{}], live_chat: [{}] },
    automatic_captions: { "en-orig": [{}], en: [{}], ru: [{}], fr: [{}] },
  });
  assert.deepEqual(subs.map((o) => o.q), ["sub:ru", "sub:de", "auto:en-orig"]);
  assert.equal(subs[0].label, "Русский");
  assert.match(subs[2].label, /оригинал/);
  assert.deepEqual(buildSubtitles({}), []);
  assert.ok(isSubtitleQ("auto:en-orig"));
  assert.ok(!isSubtitleQ("sub:en;rm"));
  assert.deepEqual(subtitleArgs("sub:ru"), ["--skip-download", "--write-subs", "--sub-langs", "ru", "--convert-subs", "srt"]);
  assert.throws(() => subtitleArgs("sub:--exec"));
  assert.equal(safeFilename("Clip", "sub:ru", ".srt"), "Clip [ru].srt");
});

test("parseSection keeps fragments inside the video and under 20 minutes", () => {
  assert.equal(parseSection(undefined), null);
  assert.deepEqual(parseSection({ from: 90.4, to: 165.2 }, 600), { from: 90, to: 166 });
  assert.throws(() => parseSection({ from: 50, to: 40 }), /позже начала/);
  assert.throws(() => parseSection({ from: 0, to: 700 }, 600), /конец видео/);
  assert.throws(() => parseSection({ from: 0, to: 1500 }), /20 минут/);
  assert.throws(() => parseSection({ from: "x", to: 5 }));
  assert.equal(safeFilename("Clip", "720", ".mp4", { from: 90, to: 166 }), "Clip [720p] 1.30-2.46.mp4");
});

test("buildOptions sends oversized and very long videos to the app", () => {
  const long = buildOptions({ duration: 5 * 3600, formats: [{ vcodec: "avc1", acodec: "none", height: 720, filesize: 900e6 }] });
  assert.equal(long[0].online, false);
  const big = buildOptions({ duration: 3600, formats: [{ vcodec: "avc1", acodec: "none", height: 1080, filesize: 2e9 }] });
  assert.equal(big[0].online, false);
});

test("safeFilename strips path and header characters", () => {
  assert.equal(safeFilename('a/b\\c:"d"\r\n', "720", ".mp4"), "a b c d [720p].mp4");
  assert.equal(safeFilename("", "audio", ".mp3"), "video.mp3");
});

test("explainFailure routes known errors", () => {
  assert.equal(explainFailure("Sign in to confirm you're not a bot").code, "blocked");
  assert.equal(explainFailure("Sign in to confirm your age").code, "age_restricted");
  assert.equal(explainFailure("ERROR: Private video").code, "private");
  assert.equal(explainFailure("Video 123 does not exist", "twitch").code, "twitch_hidden");
  assert.equal(explainFailure("something odd").code, "failed");
  assert.equal(explainFailure("ERROR: [Pinterest] 1: No video formats found!").code, "no_video");
  assert.equal(explainFailure("Your IP address is blocked from accessing this post", "tiktok").code, "geo");
});
