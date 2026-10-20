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
  serverFactory: (handler) =>
    createServer(handler).on("upgrade", (req, socket, head) => {
      if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
      else socket.destroy();
    }),
});

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

/* ================= Games (GN Math + any extra sources) ================= */
// Add more sources with the GAMES_SOURCES env var: [{"key":"x","zones":"https://…/zones.json","cover":"https://…","html":"https://…"}]
const GAME_SOURCES = (() => {
  const base = [{
    key: "gn",
    zones: ["https://cdn.jsdelivr.net/gh/gn-math/assets@main/zones.json", "https://raw.githubusercontent.com/gn-math/assets/main/zones.json"],
    cover: "https://cdn.jsdelivr.net/gh/gn-math/covers@main",
    html: "https://cdn.jsdelivr.net/gh/gn-math/html@main",
  }];
  try { if (process.env.GAMES_SOURCES) base.push(...JSON.parse(process.env.GAMES_SOURCES)); } catch (e) { console.warn("bad GAMES_SOURCES:", e.message); }
  return base;
})();
const ALLOWED_HOSTS = new Set(["cdn.jsdelivr.net", "fastly.jsdelivr.net", "gcore.jsdelivr.net", "raw.githubusercontent.com"]);
const okHost = (u) => { try { const x = new URL(u); return x.protocol === "https:" && ALLOWED_HOSTS.has(x.hostname); } catch { return false; } };

let gamesCache = { t: 0, list: [], map: new Map(), errors: [] };
async function loadGames() {
  if (Date.now() - gamesCache.t < 60 * 60 * 1000 && gamesCache.list.length) return gamesCache;
  const list = [], map = new Map(), errors = [];
  for (const src of GAME_SOURCES) {
    let raw = null;
    for (const z of [].concat(src.zones)) {
      try {
        const r = await withTimeout(fetch(z, { headers: { "user-agent": UA } }), 15000);
        if (!r.ok) throw new Error("HTTP " + r.status);
        raw = await r.json(); break;
      } catch (e) { errors.push(`${src.key}: ${z} → ${e.message}`); }
    }
    if (!raw) continue;
    const arr = Array.isArray(raw) ? raw : raw.games || raw.zones || Object.values(raw);
    arr.forEach((g, i) => {
      if (!g || typeof g !== "object") return;
      const fill = (s) => String(s || "").replace("{COVER_URL}", src.cover).replace("{HTML_URL}", src.html);
      const abs = (s, b) => (s && !/^https?:/i.test(s) ? `${b}/${s.replace(/^\//, "")}` : s);
      const id = String(g.id ?? i);
      const url = abs(fill(g.url || g.html || g.path), src.html) || `${src.html}/${id}.html`;
      const cover = abs(fill(g.cover || g.image || g.thumbnail || g.thumb), src.cover) || `${src.cover}/${id}.png`;
      const name = String(g.name || g.title || "").trim();
      if (!name) return;
      const game = { id: `${src.key}-${id}`, name, url, cover };
      list.push(game); map.set(game.id, game);
    });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  if (list.length) gamesCache = { t: Date.now(), list, map, errors };
  else gamesCache = { ...gamesCache, errors };
  return gamesCache;
}
app.get("/api/games", async (req, reply) => {
  const c = await loadGames();
  if (!c.list.length) { reply.code(502); return { games: [], errors: c.errors }; }
  return { games: c.list.map((g) => ({ id: g.id, name: g.name, cover: "/api/img?u=" + encodeURIComponent(g.cover) })), errors: c.errors };
});
app.get("/api/img", async (req, reply) => {
  const u = String(req.query?.u || "");
  if (!okHost(u)) { reply.code(400); return "bad url"; }
  try {
    const up = await withTimeout(fetch(u, { headers: { "user-agent": UA } }), 12000);
    if (!up.ok) { reply.code(up.status); return ""; }
    reply.header("content-type", up.headers.get("content-type") || "image/png").header("cache-control", "public, max-age=86400");
    return reply.send(Readable.fromWeb(up.body));
  } catch { reply.code(502); return ""; }
});
// jsDelivr serves .html as plain text, so serve it ourselves with the right content type.
app.get("/play/:id", async (req, reply) => {
  const c = await loadGames();
  const g = c.map.get(req.params.id);
  if (!g || !okHost(g.url)) { reply.code(404).type("text/plain"); return "game not found"; }
  try {
    const html = await cached("play:" + g.id, async () => {
      const r = await withTimeout(fetch(g.url, { headers: { "user-agent": UA } }), 15000);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }, 30 * 60 * 1000);
    const dir = g.url.slice(0, g.url.lastIndexOf("/") + 1);
    const base = `<base href="${dir}">`;
    reply.type("text/html; charset=utf-8");
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : base + html;
  } catch (e) { reply.code(502).type("text/plain"); return "couldn't load that game: " + (e?.message || e); }
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
