import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const publicPath = fileURLToPath(new URL("./public/", import.meta.url));

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  dns_servers: ["1.1.1.3", "1.0.0.3"],
});

const app = Fastify({
  logger: false,
  bodyLimit: 14 * 1024 * 1024,
  serverFactory: (handler) =>
    createServer(handler).on("upgrade", (req, socket, head) => {
      if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
      else socket.destroy();
    }),
});

app.addContentTypeParser(/^audio\/.*/, { parseAs: "buffer" }, (req, body, done) => done(null, body));

/* ================= Music search: YouTube Music + SoundCloud ================= */
// Both libraries are unofficial and optional. If one fails to load, the other still works.
const status = { youtube: false, soundcloud: false };
let yt = null, sc = null, ytInit = null;

const pickClass = (mod) =>
  [mod?.default?.default, mod?.default, mod?.YTMusic, mod?.Soundcloud, mod].find((x) => typeof x === "function");
const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

function ensureYT() {
  if (status.youtube) return Promise.resolve();
  if (!ytInit) {
    ytInit = (async () => {
      const YT = pickClass(await import("ytmusic-api"));
      yt = new YT();
      await yt.initialize();
      status.youtube = true;
    })().catch((e) => {
      console.warn("YouTube Music unavailable:", e?.message || e);
      ytInit = null;
      throw e;
    });
  }
  return ytInit;
}
async function ensureSC() {
  if (sc) return;
  const SC = pickClass(await import("soundcloud.ts"));
  sc = new SC();
  status.soundcloud = true;
}
ensureYT().catch(() => {});
ensureSC().catch((e) => console.warn("SoundCloud unavailable:", e?.message || e));

async function searchYouTube(q) {
  await withTimeout(ensureYT(), 10000);
  const rows = await withTimeout(yt.searchSongs(q), 10000);
  return rows.slice(0, 10).map((r) => ({
    source: "youtube",
    id: r.videoId,
    title: r.name,
    artist: r.artist?.name || "",
    thumb: r.thumbnails?.length ? r.thumbnails[r.thumbnails.length - 1].url : "",
    dur: r.duration || 0,
  }));
}
async function searchSoundCloud(q) {
  await withTimeout(ensureSC(), 10000);
  let res;
  try { res = await withTimeout(sc.tracks.searchV2({ q, limit: 10 }), 10000); }
  catch { res = await withTimeout(sc.tracks.search({ q }), 10000); }
  const rows = res?.collection ?? res ?? [];
  return rows.slice(0, 10).map((t) => ({
    source: "soundcloud",
    id: t.permalink_url,
    title: t.title,
    artist: t.user?.username || "",
    thumb: (t.artwork_url || t.user?.avatar_url || "").replace("-large", "-t300x300"),
    dur: Math.round((t.duration || 0) / 1000),
  })).filter((t) => t.id);
}

const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const BAD = /\b(remix|live|cover|karaoke|slowed|sped|reverb|nightcore|instrumental)\b/;

function score(query, t) {
  const q = norm(query), title = norm(t.title), all = norm(`${t.artist} ${t.title}`);
  if (!q || !all) return 0;
  const qw = new Set(q.split(" ")), tw = new Set(all.split(" "));
  let hit = 0;
  for (const w of qw) if (tw.has(w)) hit++;
  let s = 0.65 * (hit / qw.size) + 0.2 * (hit / tw.size);
  if (title === q) s += 0.15; else if (all.includes(q)) s += 0.1;
  if (BAD.test(title) && !BAD.test(q)) s -= 0.15;
  return s;
}

const cache = new Map();
async function musicSearch(q) {
  const hit = cache.get(q);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.data;
  const [a, b] = await Promise.allSettled([searchYouTube(q), searchSoundCloud(q)]);
  const errors = {};
  if (a.status === "rejected") errors.youtube = String(a.reason?.message || a.reason);
  if (b.status === "rejected") errors.soundcloud = String(b.reason?.message || b.reason);
  const all = [...(a.value || []), ...(b.value || [])].map((t) => ({ ...t, score: score(q, t) }));
  all.sort((x, y) => y.score - x.score);
  const seen = new Set(), results = [];
  for (const t of all) {
    const k = norm(t.artist + t.title);
    if (seen.has(k)) continue;
    seen.add(k); results.push(t);
  }
  const data = { results: results.slice(0, 12), status: { ...status }, errors };
  if (results.length) cache.set(q, { t: Date.now(), data });
  return data;
}

app.get("/api/music/status", async () => ({ status }));
app.get("/api/music/search", async (req, reply) => {
  const q = String(req.query?.q || "").trim().slice(0, 120);
  if (!q) return { results: [], status, errors: {} };
  try { return await musicSearch(q); }
  catch (e) { reply.code(502); return { results: [], status, errors: { server: String(e?.message || e) } }; }
});

/* ================= Music streaming (through this server, so the browser never talks to YouTube/SoundCloud) ================= */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const urlCache = new Map();
const cached = async (k, fn, ttl = 20 * 60 * 1000) => {
  const h = urlCache.get(k);
  if (h && Date.now() - h.t < ttl) return h.v;
  const v = await fn(); urlCache.set(k, { t: Date.now(), v }); return v;
};

async function soundcloudUrl(id) {
  await ensureSC();
  return cached("sc:" + id, async () => {
    for (const proto of ["progressive", undefined]) {
      try {
        const u = await withTimeout(proto ? sc.util.streamLink(id, proto) : sc.util.streamLink(id), 12000);
        if (u && !/\.m3u8|playlist/i.test(u)) return u;
      } catch {}
    }
    throw new Error("no direct soundcloud stream for this track");
  });
}
async function youtubeUrl(id) {
  return cached("yt:" + id, async () => {
    const mod = await import("@distube/ytdl-core");
    const ytdl = [mod?.default?.default, mod?.default, mod].find((x) => typeof x === "function" || typeof x?.getInfo === "function");
    const info = await withTimeout(ytdl.getInfo(`https://www.youtube.com/watch?v=${id}`), 15000);
    const audio = info.formats.filter((f) => f.hasAudio && !f.hasVideo);
    const byRate = (a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0);
    const pick = audio.filter((f) => /mp4/.test(f.mimeType || "")).sort(byRate)[0] || audio.sort(byRate)[0];
    if (!pick?.url) throw new Error("no audio format found");
    return pick.url;
  });
}

app.get("/api/music/stream", async (req, reply) => {
  const source = String(req.query?.source || ""), id = String(req.query?.id || "");
  if (!id || !["youtube", "soundcloud"].includes(source)) { reply.code(400); return { error: "bad request" }; }
  try {
    const url = source === "soundcloud" ? await soundcloudUrl(id) : await youtubeUrl(id);
    const range = req.headers.range;
    const up = await fetch(url, { headers: { "user-agent": UA, ...(range ? { range } : {}) } });
    if (!up.ok && up.status !== 206) throw new Error("upstream " + up.status);
    reply.code(up.status);
    for (const h of ["content-type", "content-length", "content-range"]) { const v = up.headers.get(h); if (v) reply.header(h, v); }
    reply.header("accept-ranges", "bytes").header("cache-control", "no-store");
    return reply.send(Readable.fromWeb(up.body));
  } catch (e) {
    urlCache.delete((source === "soundcloud" ? "sc:" : "yt:") + id);
    reply.code(502); return { error: String(e?.message || e) };
  }
});

// Find the closest SoundCloud version of a track (used when a YouTube stream can't be fetched)
app.get("/api/music/alt", async (req, reply) => {
  const q = String(req.query?.q || "").trim().slice(0, 140);
  if (!q) { reply.code(400); return {}; }
  try {
    const rows = await searchSoundCloud(q);
    const best = rows.map((t) => ({ ...t, score: score(q, t) })).sort((a, b) => b.score - a.score)[0];
    return { track: best || null };
  } catch (e) { reply.code(502); return { track: null, error: String(e?.message || e) }; }
});

/* ================= Lyrics (LRCLIB, the same free community library Versed uses) ================= */
const lyricCache = new Map();
const cleanTitle = (t) =>
  String(t || "").replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(official|music video|video|audio|lyrics?|lyric video|visuali[sz]er|hd|4k|remaster(ed)?( \d{4})?)\b/gi, " ")
    .replace(/\s*[-–]\s*topic$/i, "").replace(/\s*(feat|ft)\.?\s.*$/i, "").replace(/\s+/g, " ").trim();

function parseLrc(lrc) {
  const out = [];
  for (const line of String(lrc || "").split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) out.push({ t: +m[1] * 60 + parseFloat(m[2]), text });
  }
  return out.sort((x, y) => x.t - y.t);
}

app.get("/api/lyrics", async (req, reply) => {
  let title = cleanTitle(req.query?.title), artist = cleanTitle(req.query?.artist);
  const dur = Number(req.query?.dur) || 0;
  if (!title) { reply.code(400); return { error: "missing title" }; }
  const parts = title.split(/\s+[-–]\s+/);
  if (parts.length === 2) {
    const a = norm(artist), p0 = norm(parts[0]);
    if (!a || a.includes(p0) || p0.includes(a)) { artist = artist || parts[0]; title = parts[1]; }
  }
  const ck = norm(artist + " " + title) + "|" + Math.round(dur / 5);
  const hit = lyricCache.get(ck);
  if (hit && Date.now() - hit.t < 6 * 60 * 60 * 1000) return hit.v;
  const H = { headers: { "user-agent": "Nex.Velo (https://github.com/Calbee-o143/Nex.Velo)" } };
  const urls = [
    `https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`,
    `https://lrclib.net/api/search?q=${encodeURIComponent((artist + " " + title).trim())}`,
  ];
  let best = null;
  for (const u of urls) {
    try {
      const r = await withTimeout(fetch(u, H), 9000);
      if (!r.ok) continue;
      const rows = (await r.json()).filter((x) => x.syncedLyrics || x.plainLyrics || x.instrumental);
      for (const x of rows) {
        let sc = 0.6 * score(title, { title: x.trackName, artist: x.artistName });
        if (dur && x.duration && Math.abs(x.duration - dur) <= 4) sc += 0.3;
        if (x.syncedLyrics) sc += 0.2;
        if (!best || sc > best.sc) best = { sc, x };
      }
      if (best && best.sc > 0.6) break;
    } catch {}
  }
  const v = best && best.sc > 0.25
    ? { found: true, instrumental: !!best.x.instrumental, synced: parseLrc(best.x.syncedLyrics), plain: best.x.plainLyrics || "", title: best.x.trackName, artist: best.x.artistName }
    : { found: false };
  lyricCache.set(ck, { t: Date.now(), v });
  return v;
});

/* ================= AI chat (Groq: OpenAI GPT OSS for text, a vision model when images are attached) ================= */
// Set GROQ_API_KEY on the server, or each person pastes their own key in the AI tab (kept in their browser).
const AI_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";
const aiKey = (req) => String(req.headers["x-groq-key"] || process.env.GROQ_API_KEY || "").trim();

app.get("/api/ai/status", async () => ({ serverKey: !!process.env.GROQ_API_KEY, models: AI_MODELS, vision: VISION_MODEL }));

function cleanMessages(list) {
  const out = []; let hasImage = false;
  for (const m of (Array.isArray(list) ? list : []).slice(-40)) {
    if (!m || !["system", "user", "assistant"].includes(m.role)) continue;
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content.slice(0, 20000) }); continue; }
    if (m.role === "user" && Array.isArray(m.content)) {
      const parts = [];
      for (const p of m.content.slice(0, 6)) {
        if (p?.type === "text" && typeof p.text === "string") parts.push({ type: "text", text: p.text.slice(0, 20000) });
        else if (p?.type === "image_url" && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(p.image_url?.url || "") && p.image_url.url.length < 6e6) {
          parts.push({ type: "image_url", image_url: { url: p.image_url.url } }); hasImage = true;
        }
      }
      if (parts.length) out.push({ role: "user", content: parts });
    }
  }
  return { messages: out, hasImage };
}

app.post("/api/ai/chat", async (req, reply) => {
  const key = aiKey(req);
  if (!key) { reply.code(401); return { error: "no_key" }; }
  const body = req.body || {};
  const { messages, hasImage } = cleanMessages(body.messages);
  if (!messages.length) { reply.code(400); return { error: "no messages" }; }
  const model = hasImage ? VISION_MODEL : AI_MODELS.includes(body.model) ? body.model : AI_MODELS[1];
  try {
    const up = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true, temperature: 0.7, max_tokens: 4096 }),
    });
    if (!up.ok) { const t = await up.text(); reply.code(up.status); return { error: t.slice(0, 400), model }; }
    reply.header("content-type", "text/event-stream").header("cache-control", "no-cache").header("x-model", model);
    return reply.send(Readable.fromWeb(up.body));
  } catch (e) { reply.code(502); return { error: String(e?.message || e) }; }
});

// Voice: browser sends a short recording, Groq Whisper turns it into text.
app.post("/api/ai/transcribe", async (req, reply) => {
  const key = aiKey(req);
  if (!key) { reply.code(401); return { error: "no_key" }; }
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 800) { reply.code(400); return { error: "recording too short" }; }
  const type = String(req.headers["content-type"] || "audio/webm").split(";")[0];
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
  try {
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type }), "voice." + ext);
    fd.append("model", STT_MODEL); fd.append("response_format", "json");
    const up = await withTimeout(fetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: fd }), 30000);
    const d = await up.json().catch(() => ({}));
    if (!up.ok) { reply.code(up.status); return { error: d?.error?.message || "transcription failed" }; }
    return { text: String(d.text || "").trim() };
  } catch (e) { reply.code(502); return { error: String(e?.message || e) }; }
});

/* ================= Static site ================= */
app.register(fastifyStatic, { root: publicPath });
app.addHook("onSend", async (req, reply, payload) => {
  if (req.url.split("?")[0] === "/sw.js") reply.header("Cache-Control", "no-cache");
  return payload;
});

const port = Number(process.env.PORT) || 8080;
app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log(`Nex.Velo running on http://localhost:${port}`);
});
