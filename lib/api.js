// All /api routes live here so they can run on the Nex.Velo server (Railway) AND as a Vercel function.
import { Readable } from "node:stream";

export function registerApi(app) {
// Let other hosts (e.g. the Vercel copy of the site) call the API on this server.
app.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/api/")) return;
  reply.header("access-control-allow-origin", "*")
    .header("access-control-allow-headers", "content-type,x-groq-key")
    .header("access-control-allow-methods", "GET,POST,OPTIONS")
    .header("access-control-expose-headers", "x-model");
  if (req.method === "OPTIONS") { reply.code(204); return reply.send(); }
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
    let lastErr = "";
    for (const proto of ["progressive", "hls", undefined]) {
      try {
        const u = await withTimeout(proto ? sc.util.streamLink(id, proto) : sc.util.streamLink(id), 12000);
        if (u) return { url: u, hls: /\.m3u8|\/playlist\//i.test(u) };
      } catch (e) { lastErr = String(e?.message || e); }
    }
    throw new Error("soundcloud gave no stream for this track" + (lastErr ? " (" + lastErr + ")" : ""));
  });
}
// HLS = a playlist of small audio files. For mp3/aac pieces, sending them one after another is a valid audio stream.
async function streamHls(m3u8Url, reply) {
  const get = async (u) => {
    const r = await withTimeout(fetch(u, { headers: { "user-agent": UA } }), 15000);
    if (!r.ok) throw new Error("hls " + r.status);
    return r;
  };
  let base = m3u8Url, text = await (await get(base)).text();
  if (/#EXT-X-STREAM-INF/.test(text)) {   // master playlist: take the first quality
    const ls = text.split(/\r?\n/), i = ls.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
    const next = ls.slice(i + 1).find((l) => l && !l.startsWith("#"));
    if (!next) throw new Error("empty hls playlist");
    base = new URL(next, base).href; text = await (await get(base)).text();
  }
  if (/#EXT-X-MAP/.test(text)) throw new Error("this track's stream format isn't supported");
  const segs = text.split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => new URL(l, base).href);
  if (!segs.length) throw new Error("empty hls playlist");
  const first = await get(segs[0]);
  const type = first.headers.get("content-type") || "";
  const mime = /mpeg|mp3/i.test(type) || /\.mp3(\?|$)/i.test(segs[0]) ? "audio/mpeg" : /aac/i.test(type) || /\.aac(\?|$)/i.test(segs[0]) ? "audio/aac" : null;
  if (!mime) throw new Error("this track's audio format isn't supported (" + (type || "unknown") + ")");
  const firstBuf = Buffer.from(await first.arrayBuffer());
  async function* pieces() {
    yield firstBuf;
    for (let i = 1; i < segs.length; i++) yield Buffer.from(await (await get(segs[i])).arrayBuffer());
  }
  reply.code(200).header("content-type", mime).header("accept-ranges", "none").header("cache-control", "no-store");
  return reply.send(Readable.from(pieces()));
}
app.__streamHls = streamHls;   // used by the tests

// Public Piped servers can hand out YouTube audio when YouTube blocks this server directly (they come and go; set PIPED_INSTANCES to change the list)
async function pipedUrl(id) {
  const bases = (process.env.PIPED_INSTANCES || "https://pipedapi.kavin.rocks,https://pipedapi.adminforge.de,https://api.piped.private.coffee").split(",").map((x) => x.trim()).filter(Boolean);
  for (const base of bases) {
    try {
      const r = await withTimeout(fetch(`${base}/streams/${id}`, { headers: { "user-agent": UA } }), 8000);
      if (!r.ok) continue;
      const d = await r.json();
      const list = (d.audioStreams || []).filter((x) => x.url);
      const pick = list.filter((x) => /mp4|m4a|aac|mpeg/i.test(`${x.mimeType} ${x.format}`)).sort((x, y) => (y.bitrate || 0) - (x.bitrate || 0))[0] || list[0];
      if (pick?.url) return pick.url;
    } catch {}
  }
  throw new Error("no piped server answered");
}
async function youtubeUrl(id) {
  return cached("yt:" + id, async () => {
    let first = "";
    try {
      const mod = await import("@distube/ytdl-core");
      const ytdl = [mod?.default?.default, mod?.default, mod].find((x) => typeof x === "function" || typeof x?.getInfo === "function");
      const info = await withTimeout(ytdl.getInfo(`https://www.youtube.com/watch?v=${id}`), 15000);
      const audio = info.formats.filter((f) => f.hasAudio && !f.hasVideo);
      const byRate = (a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0);
      const pick = audio.filter((f) => /mp4/.test(f.mimeType || "")).sort(byRate)[0] || audio.sort(byRate)[0];
      if (pick?.url) return pick.url;
      first = "no audio format found";
    } catch (e) { first = String(e?.message || e); }
    try { return await pipedUrl(id); }
    catch { throw new Error("youtube wouldn't give audio (" + first.slice(0, 120) + ")"); }
  });
}
async function bestSoundCloud(q) {
  const rows = await searchSoundCloud(q);
  return rows.map((t) => ({ ...t, score: score(q, t) })).sort((a, b) => b.score - a.score)[0] || null;
}

app.get("/api/music/stream", async (req, reply) => {
  const source = String(req.query?.source || ""), id = String(req.query?.id || "");
  if (!id || !["youtube", "soundcloud"].includes(source)) { reply.code(400); return { error: "bad request" }; }
  try {
    let found;
    if (source === "soundcloud") found = await soundcloudUrl(id);
    else {
      try { found = { url: await youtubeUrl(id), hls: false }; }
      catch (ye) {
        const q = String(req.query?.q || "").trim().slice(0, 140);          // only used when the page asks for a SoundCloud fallback
        const alt = q ? await bestSoundCloud(q).catch(() => null) : null;
        if (!alt) throw ye;
        found = await soundcloudUrl(alt.id);
      }
    }
    if (found.hls) return await streamHls(found.url, reply);
    const url = found.url, range = req.headers.range;
    const up = await fetch(url, { headers: { "user-agent": UA, ...(range ? { range } : {}) } });
    if (!up.ok && up.status !== 206) throw new Error("upstream " + up.status);
    reply.code(up.status);
    for (const h of ["content-type", "content-length", "content-range"]) { const v = up.headers.get(h); if (v) reply.header(h, v); }
    reply.header("accept-ranges", "bytes").header("cache-control", "no-store");
    return reply.send(Readable.fromWeb(up.body));
  } catch (e) {
    urlCache.delete((source === "soundcloud" ? "sc:" : "yt:") + id);
    console.warn("[stream failed]", source, id, String(e?.message || e));
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

/* ================= Recommended music (a fixed list of well-known songs, matched through the same search) ================= */
const RECOMMENDED = [
  "Blinding Lights The Weeknd", "Levitating Dua Lipa", "As It Was Harry Styles", "Flowers Miley Cyrus",
  "Anti-Hero Taylor Swift", "Espresso Sabrina Carpenter", "Starboy The Weeknd", "Heat Waves Glass Animals",
  "Sunflower Post Malone", "good 4 u Olivia Rodrigo", "Stay The Kid LAROI Justin Bieber", "Shape of You Ed Sheeran",
];
let recCache = { t: 0, tracks: [] };
app.get("/api/music/recommended", async () => {
  if (recCache.tracks.length && Date.now() - recCache.t < 6 * 60 * 60 * 1000) return { tracks: recCache.tracks };
  const tracks = [];
  for (let i = 0; i < RECOMMENDED.length; i += 4) {   // four searches at a time
    const batch = await Promise.allSettled(RECOMMENDED.slice(i, i + 4).map((q) => musicSearch(q)));
    for (const r of batch) { const t = r.status === "fulfilled" && r.value.results?.[0]; if (t) tracks.push(t); }
  }
  if (tracks.length) recCache = { t: Date.now(), tracks };
  return { tracks };
});

/* ================= Site icons for bookmarks (fetched here so a blocked network doesn't matter) ================= */
app.get("/api/favicon", async (req, reply) => {
  const host = String(req.query?.host || "").toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.length > 120) { reply.code(400); return ""; }
  const urls = [`https://icons.duckduckgo.com/ip3/${host}.ico`, `https://www.google.com/s2/favicons?domain=${host}&sz=64`];
  for (const u of urls) {
    try {
      const r = await withTimeout(fetch(u, { headers: { "user-agent": UA } }), 6000);
      const type = r.headers.get("content-type") || "";
      if (!r.ok || !/image/i.test(type)) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 60) continue;
      reply.header("content-type", type).header("cache-control", "public, max-age=604800");
      return reply.send(buf);
    } catch {}
  }
  reply.code(404); return "";
});

/* ================= Live visitors (anonymous, counted while a page keeps pinging) ================= */
const visitors = new Map();
const liveCount = () => { const now = Date.now(); for (const [id, t] of visitors) if (now - t > 60000) visitors.delete(id); return visitors.size; };
app.get("/api/live", async () => ({ count: liveCount() }));
app.post("/api/live/ping", async (req) => {
  const id = String(req.body?.id || "");
  if (/^[a-z0-9-]{8,48}$/i.test(id)) visitors.set(id, Date.now());
  return { count: liveCount() };
});

/* ================= Game search for DuckMath and Weslack =================
   The game list is read from each site's sitemap (or its home page links). Opening a game finds the
   game's own player frame so the site's menus and ads can be left out. Both depend on how each site is built. */
const GAME_SITES = { duckmath: "https://duckmath.org", weslack: "https://weslack.com" };
const SKIP_SLUG = /^(about|about-us|contact|contact-us|privacy|privacy-policy|terms|terms-of-service|dmca|search|category|categories|tag|tags|page|login|register|blog|sitemap|feed|cookie|cookies|policy|faq|help|games|new|popular|top|best|all|home|index|404)$/i;
const titleCase = (t) => t.replace(/[-_+]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
async function fetchText(url) {
  const r = await withTimeout(fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xml,*/*" }, redirect: "follow" }), 12000);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}
const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
const gameFromUrl = (u, host) => {
  try {
    const x = new URL(u);
    if (x.hostname.replace(/^www\./, "") !== host) return null;
    const segs = x.pathname.split("/").filter(Boolean);
    if (!segs.length || segs.length > 3) return null;
    const slug = decodeURIComponent(segs[segs.length - 1]).replace(/\.html?$/i, "");
    if (!slug || SKIP_SLUG.test(slug) || /^(category|tag|page|author|search)$/i.test(segs[0]) || /\.(xml|png|jpe?g|gif|css|js|txt|ico)$/i.test(slug)) return null;
    return { name: titleCase(slug), url: x.href };
  } catch { return null; }
};
const gamesCache = {};
async function siteGames(key) {
  const hit = gamesCache[key];
  if (hit && Date.now() - hit.t < 60 * 60 * 1000 && hit.list.length) return hit;
  const base = GAME_SITES[key], host = new URL(base).hostname.replace(/^www\./, "");
  let urls = [], tried = [];
  try {
    let l = locs(await fetchText(base + "/sitemap.xml"));
    const subs = l.filter((u) => /\.xml(\?|$)/i.test(u));
    if (subs.length) { l = l.filter((u) => !/\.xml(\?|$)/i.test(u)); for (const s of subs.slice(0, 10)) { try { l.push(...locs(await fetchText(s))); } catch {} } }
    urls = l;
  } catch (e) { tried.push("sitemap.xml: " + e.message); }
  if (!urls.length) {
    try {
      const robots = await fetchText(base + "/robots.txt");
      for (const sm of [...robots.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]).slice(0, 4)) { try { urls.push(...locs(await fetchText(sm))); } catch {} }
    } catch (e) { tried.push("robots.txt: " + e.message); }
  }
  let list = urls.map((u) => gameFromUrl(u, host)).filter(Boolean);
  if (list.length < 5) {   // fall back to the links on the home page
    try {
      const html = await fetchText(base + "/");
      for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        let abs; try { abs = new URL(m[1], base + "/").href; } catch { continue; }
        const g = gameFromUrl(abs, host); if (!g) continue;
        const alt = (m[2].match(/\balt=["']([^"']+)["']/i) || [])[1];
        const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        g.name = (alt || (text.length > 1 && text.length < 60 ? text : g.name)).slice(0, 60);
        list.push(g);
      }
    } catch (e) { tried.push("home page: " + e.message); }
  }
  const seen = new Set(); list = list.filter((g) => !seen.has(g.url) && seen.add(g.url));
  list.sort((a, b) => a.name.localeCompare(b.name));
  const out = { t: Date.now(), list, tried };
  if (list.length) gamesCache[key] = out;
  return out;
}
app.get("/api/games/list", async (req, reply) => {
  const site = String(req.query?.src || req.query?.site || "");
  if (site === "gn" || site === "cherri") {
    try { const games = await (site === "gn" ? gnGames() : cherriGames()); return { games, count: games.length, kind: "library" }; }
    catch (e) { console.warn("[games]", site, String(e?.message || e)); reply.code(502); return { games: [], error: String(e?.message || e) }; }
  }
  if (!GAME_SITES[site]) { reply.code(400); return { error: "unknown site" }; }
  const g = await siteGames(site);
  if (!g.list.length) { reply.code(502); return { games: [], error: "couldn't read the game list. " + g.tried.join("; ") }; }
  return { games: g.list.map(({ name, url }) => ({ name, url })), count: g.list.length };
});
const BAD_FRAME = /(googletagmanager|doubleclick|googlesyndication|facebook\.|twitter\.|youtube\.com\/embed|disqus|adservice|recaptcha|addthis|gstatic)/i;
app.get("/api/games/open", async (req, reply) => {
  const site = String(req.query?.site || ""), url = String(req.query?.url || "");
  if (!GAME_SITES[site]) { reply.code(400); return { error: "unknown site" }; }
  let host; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { reply.code(400); return { error: "bad url" }; }
  if (host !== new URL(GAME_SITES[site]).hostname.replace(/^www\./, "")) { reply.code(400); return { error: "that address isn't on this site" }; }
  try {
    const html = await fetchText(url);
    for (const m of html.matchAll(/<iframe\b[^>]*?\b(?:data-src|src)=["']([^"']+)["'][^>]*>/gi)) {
      if (BAD_FRAME.test(m[1])) continue;
      let src; try { src = new URL(m[1], url).href; } catch { continue; }
      if (/^https?:/i.test(src)) return { embed: src };
    }
    return { embed: null };
  } catch (e) { reply.code(502); return { embed: null, error: String(e?.message || e) }; }
});

/* ================= Open-source game libraries =================
   GN Math (GitHub, via jsDelivr) and Cherri Games (GitLab). Their files are served from here with the right content
   type, so a game's own pages, scripts and images load from one place (and through the proxy). */
const FILE_MIME = { html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", js: "application/javascript; charset=utf-8", mjs: "application/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", wasm: "application/wasm", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", txt: "text/plain; charset=utf-8", xml: "application/xml" };
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
const LIB_RAW = {
  cherri: (p) => `https://gitlab.com/x8r/cherrigames/-/raw/main/${encPath(p)}`,
  gnhtml: (p) => `https://cdn.jsdelivr.net/gh/gn-math/html@main/${encPath(p)}`,
  gnassets: (p) => `https://cdn.jsdelivr.net/gh/gn-math/assets@main/${encPath(p)}`,
  gncovers: (p) => `https://cdn.jsdelivr.net/gh/gn-math/covers@main/${encPath(p)}`,
};
app.get("/api/games/f/:lib/*", async (req, reply) => {
  const lib = req.params.lib; let p = String(req.params["*"] || "");
  try { p = decodeURIComponent(p); } catch {}
  if (!LIB_RAW[lib] || p.includes("..") || p.includes("\\")) { reply.code(400); return "bad path"; }
  if (!p || p.endsWith("/")) p += "index.html";
  try {
    const up = await withTimeout(fetch(LIB_RAW[lib](p), { headers: { "user-agent": UA }, redirect: "follow" }), 25000);
    if (!up.ok) { reply.code(up.status === 404 ? 404 : 502); return "not found"; }
    const ext = ((p.match(/\.([a-z0-9]+)$/i) || [])[1] || "").toLowerCase();
    reply.header("content-type", FILE_MIME[ext] || up.headers.get("content-type") || "application/octet-stream")
      .header("cache-control", "public, max-age=3600").header("access-control-allow-origin", "*");
    return reply.send(Readable.fromWeb(up.body));
  } catch (e) { console.warn("[games file]", lib, p, String(e?.message || e)); reply.code(502); return "couldn't load that file"; }
});

async function gnGames() {
  return cached("gn:list", async () => {
    let raw = null, err = "";
    for (const u of ["https://cdn.jsdelivr.net/gh/gn-math/assets@main/zones.json", "https://raw.githubusercontent.com/gn-math/assets/main/zones.json"]) {
      try { const r = await withTimeout(fetch(u, { headers: { "user-agent": UA } }), 20000); if (!r.ok) throw new Error("HTTP " + r.status); raw = await r.json(); break; }
      catch (e) { err = String(e?.message || e); }
    }
    if (!raw) throw new Error("couldn't read the GN Math list (" + err + ")");
    const arr = Array.isArray(raw) ? raw : raw.games || raw.zones || Object.values(raw);
    const games = [];
    arr.forEach((g, i) => {
      const name = String(g?.name || g?.title || "").trim(); if (!name) return;
      const id = String(g.id ?? i);
      const tail = (v, d) => String(v || d).replace(/^\{[A-Z_]+\}\//, "").replace(/^https?:\/\/[^/]+\/gh\/gn-math\/[a-z]+@main\//, "");
      games.push({ name, play: "/api/games/f/gnhtml/" + encPath(tail(g.url, id + ".html")), thumb: "/api/games/f/gncovers/" + encPath(tail(g.cover, id + ".png")) });
    });
    if (!games.length) throw new Error("the GN Math list was empty");
    games.sort((a, b) => a.name.localeCompare(b.name)); return games;
  }, 6 * 60 * 60 * 1000);
}

async function cherriGames() {
  return cached("cherri:list", async () => {
    const proj = encodeURIComponent("x8r/cherrigames");
    const paths = [];
    for (let page = 1; page <= 40; page++) {
      const r = await withTimeout(fetch(`https://gitlab.com/api/v4/projects/${proj}/repository/tree?recursive=true&per_page=100&page=${page}&ref=main`, { headers: { "user-agent": UA } }), 20000);
      if (!r.ok) throw new Error("GitLab answered " + r.status);
      const rows = await r.json();
      for (const x of rows) if (x.type === "blob") paths.push(x.path);
      if (rows.length < 100) break;
    }
    console.log("[cherri] files:", paths.length, "| first 40:", paths.slice(0, 40).join(" | "));
    const enc = (p) => "/api/games/f/cherri/" + encPath(p);
    // 1) a list file (games.json and similar)
    const cand = paths.filter((p) => /\.json$/i.test(p) && p.split("/").length <= 3 && /(games|gamelist|library|catalog|zones|data)/i.test(p)).slice(0, 6);
    for (const p of cand) {
      try {
        const j = await (await withTimeout(fetch(LIB_RAW.cherri(p), { headers: { "user-agent": UA } }), 20000)).json();
        const arr = Array.isArray(j) ? j : j.games || j.list || j.items || Object.values(j);
        if (!Array.isArray(arr) || arr.length < 5 || !arr[0] || !(arr[0].name || arr[0].title)) continue;
        const out = [];
        for (const g of arr) {
          const name = String(g.name || g.title || "").trim();
          let u = g.url || g.path || g.link || g.file || g.html || g.href || g.src || g.index;
          const img = g.image || g.img || g.thumb || g.thumbnail || g.icon || g.cover || g.poster;
          if (!name || typeof u !== "string") continue;
          const thumb = typeof img === "string" ? (/^https?:/i.test(img) ? img : enc(img.replace(/^\.?\//, ""))) : "";
          if (/^https?:/i.test(u)) { out.push({ name, url: u, thumb }); continue; }
          u = u.replace(/^\.?\//, ""); if (!/\.[a-z0-9]+$/i.test(u)) u = u.replace(/\/?$/, "/") + "index.html";
          out.push({ name, play: enc(u), thumb });
        }
        if (out.length >= 5) { out.sort((a, b) => a.name.localeCompare(b.name)); return out; }
      } catch {}
    }
    // 2) folders that hold an index.html
    const byDir = {};
    for (const p of paths) { const d = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""; (byDir[d] ||= []).push(p); }
    const games = [], seen = new Set();
    for (const p of paths) {
      if (!/\/index\.html?$/i.test(p)) continue;
      const dir = p.slice(0, p.lastIndexOf("/")), depth = dir.split("/").length;
      if (!dir || depth > 3 || seen.has(dir)) continue;
      if (/(^|\/)(\.|node_modules|assets|static|public|lib|src|css|js|images|img|fonts|vendor|common)(\/|$)/i.test(dir)) continue;
      seen.add(dir);
      const thumbFile = (byDir[dir] || []).find((f) => /(thumb|icon|cover|logo|preview|banner|splash)[^/]*\.(png|jpe?g|webp|gif)$/i.test(f));
      games.push({ name: titleCase(dir.split("/").pop()), play: enc(p), thumb: thumbFile ? enc(thumbFile) : "" });
    }
    // 3) single html files
    if (games.length < 20) for (const p of paths) {
      if (!/\.html?$/i.test(p) || /index\.html?$/i.test(p) || p.split("/").length > 3 || /(404|template|test)/i.test(p)) continue;
      games.push({ name: titleCase(p.replace(/\.html?$/i, "").split("/").pop()), play: enc(p), thumb: "" });
    }
    if (!games.length) throw new Error("no games found in the Cherri repository (" + paths.length + " files looked at)");
    games.sort((a, b) => a.name.localeCompare(b.name)); return games;
  }, 6 * 60 * 60 * 1000);
}

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

/* ================= AI chat =================
   Default: "Nex.AI", a small open-source model (Qwen) that runs on this server. No outside AI company, no key.
   It can look facts up on Wikipedia first, so it answers from real sources instead of guessing.
   Optional: someone can add their own Groq key to use bigger models and to send images. */
const AI_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const LOCAL_MODEL = process.env.NEXAI_MODEL || "onnx-community/Qwen2.5-0.5B-Instruct";
const aiKey = (req) => String(req.headers["x-groq-key"] || process.env.GROQ_API_KEY || "").trim();

let local = { gen: null, T: null, loading: null, last: 0, error: "", queue: Promise.resolve() };
async function memoryOk() {
  try {
    const fs = await import("node:fs");
    for (const p of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
      try {
        const v = fs.readFileSync(p, "utf8").trim(), lim = Number(v);
        if (v && v !== "max" && lim > 0 && lim < 1.3e9) return false;   // the model needs about 1.2 GB
      } catch {}
    }
  } catch {}
  return true;
}
function getLocal() {
  if (local.gen) return Promise.resolve(local.gen);
  if (!local.loading) {
    local.loading = (async () => {
      if (!(await memoryOk())) throw new Error("this server doesn't have enough memory for the built-in model (it needs about 1.5 GB)");
      const name = "@huggingface/" + "transformers";   // built from pieces so Vercel doesn't bundle the model runtime. It only runs on the Nex.Velo server.
      let T;
      try { T = await import(name); } catch { throw new Error("the built-in model isn't installed on this host (it runs on the Nex.Velo server)"); }
      T.env.cacheDir = process.env.NEXAI_CACHE || "/tmp/nexai"; T.env.allowLocalModels = false;
      local.gen = await T.pipeline("text-generation", LOCAL_MODEL, { dtype: "q4" });
      local.T = T; local.error = "";
      console.log("[nex.ai] model ready:", LOCAL_MODEL);
      return local.gen;
    })().catch((e) => { local.loading = null; local.error = String(e?.message || e); console.warn("[nex.ai] could not load:", local.error); throw e; });
  }
  return local.loading;
}
setInterval(async () => {   // free the memory when nobody has used the model for ten minutes
  if (local.gen && Date.now() - local.last > 10 * 60 * 1000) { try { await local.gen.dispose?.(); } catch {} local.gen = null; local.loading = null; }
}, 60 * 1000).unref?.();

app.get("/api/ai/status", async () => ({
  canRun: !process.env.VERCEL, ready: !!local.gen, loading: !!local.loading && !local.gen, error: local.error,
  model: LOCAL_MODEL, serverKey: !!process.env.GROQ_API_KEY, models: AI_MODELS, vision: VISION_MODEL,
}));

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

// Facts from Wikipedia (free, no key) so a small model can answer from sources instead of guessing.
const looksLikeQuestion = (t) => t.trim().split(/\s+/).length >= 3 && (/\?\s*$/.test(t) || /^(what|who|when|where|why|how|which|tell me|explain|define|is|are|was|were|does|do|did|can)\b/i.test(t.trim()));
async function wikiFacts(question) {
  try {
    const q = question.replace(/[?!.]+$/g, "").slice(0, 150);
    const url = "https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrlimit=2&prop=extracts&exintro=1&explaintext=1&exchars=700&format=json&origin=*&gsrsearch=" + encodeURIComponent(q);
    const r = await withTimeout(fetch(url, { headers: { "user-agent": UA } }), 6000);
    if (!r.ok) return "";
    const pages = Object.values((await r.json())?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    return pages.filter((p) => p.extract).map((p) => `${p.title}: ${p.extract.replace(/\s+/g, " ").trim()}`).join("\n\n");
  } catch { return ""; }
}

// Our own model: text only, one answer at a time, streamed in the same format the page already reads.
async function localChat(req, reply, messages, web) {
  let flat = messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") }));
  const sys = flat.find((m) => m.role === "system") || { role: "system", content: "You are Nex.AI, a friendly assistant. Keep answers short and clear." };
  let convo = flat.filter((m) => m.role !== "system").slice(-10), total = 0;       // a small model does best with a short conversation
  convo = convo.reverse().filter((m) => (total += m.content.length) < 6500).reverse();
  const lastUser = [...convo].reverse().find((m) => m.role === "user");
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*", "x-model": "nex-ai-local" });
  const send = (text) => raw.write("data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n");
  let stop = null, closed = false;
  req.raw.on("close", () => { closed = true; try { stop?.interrupt(); } catch {} });
  const turn = local.queue.then(async () => {
    try {
      let facts = "";
      if (web && lastUser && looksLikeQuestion(lastUser.content)) facts = await wikiFacts(lastUser.content);
      const system = { role: "system", content: sys.content + (facts ? "\n\nFacts from Wikipedia. Use them if they help, and say when you are not sure:\n" + facts : "") };
      if (!local.gen) send("(waking up Nex.AI. the first answer after a quiet spell can take a minute while the model loads…)\n\n");
      const gen = await getLocal();
      if (closed) return;
      local.last = Date.now();
      const T = local.T; stop = new T.InterruptableStoppingCriteria();
      const streamer = new T.TextStreamer(gen.tokenizer, { skip_prompt: true, skip_special_tokens: true, callback_function: (t) => { if (!closed) send(t); } });
      await gen([system, ...convo], { max_new_tokens: 600, do_sample: true, temperature: 0.7, top_p: 0.9, repetition_penalty: 1.1, streamer, stopping_criteria: stop });
      local.last = Date.now();
    } catch (e) { console.warn("[nex.ai]", String(e?.message || e)); if (!closed) send("⚠️ " + String(e?.message || e)); }
  });
  local.queue = turn.catch(() => {});
  await turn;
  if (!closed) { raw.write("data: [DONE]\n\n"); raw.end(); }
  return reply;
}

app.post("/api/ai/chat", async (req, reply) => {
  const body = req.body || {};
  const { messages, hasImage } = cleanMessages(body.messages);
  if (!messages.length) { reply.code(400); return { error: "no messages" }; }
  if ((body.model === "local" || !body.model) && !hasImage) return localChat(req, reply, messages, body.web !== false);
  // an outside model: only when the person added their own key (or the server has one) and asked for it
  const key = aiKey(req);
  if (!key) { reply.code(401); return { error: "no_key" }; }
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

}
