// All /api routes live here so they can run on the Nex.Velo server (Railway) AND as a Vercel function.

import { Readable } from "node:stream";

export function registerApi(app) {
  // Let other hosts (e.g. the Vercel copy of the site) call the API on this server.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    reply.header("access-control-allow-origin", "*")
      .header("access-control-allow-headers", "content-type,x-groq-key,range")
      .header("access-control-allow-methods", "GET,POST,OPTIONS")
      .header("access-control-expose-headers", "x-model,content-range,accept-ranges");
    if (req.method === "OPTIONS") { reply.code(204); return reply.send(); }
  });

  app.addContentTypeParser(/^audio\/.*/, { parseAs: "buffer" }, (req, body, done) => done(null, body));

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

  const urlCache = new Map();
  const cached = async (k, fn, ttl = 20 * 60 * 1000) => {
    const h = urlCache.get(k);
    if (h && Date.now() - h.t < ttl) return h.v;
    const v = await fn(); urlCache.set(k, { t: Date.now(), v }); return v;
  };

  async function fetchText(url) {
    const r = await withTimeout(fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xml,*/*" }, redirect: "follow" }), 12000);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }

  /* ================= Music search: YouTube Music + SoundCloud + Audius ================= */
  // Every source is optional. If one fails, the others still work.
  const status = { youtube: false, soundcloud: false, audius: false };
  let yt = null, ytInit = null;

  const pickClass = (mod) =>
    [mod?.default?.default, mod?.default, mod?.YTMusic, mod].find((x) => typeof x === "function");

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

  /* ---- SoundCloud, talked to directly (no library): find a public client id, then use the v2 API ---- */
  const sc2 = { id: process.env.SOUNDCLOUD_CLIENT_ID || "", t: Date.now(), pending: null };

  async function scClientId(force) {
    if (!force && sc2.id && Date.now() - sc2.t < 6 * 60 * 60 * 1000) return sc2.id;
    if (!force && sc2.pending) return sc2.pending;
    sc2.pending = (async () => {
      const home = await fetchText("https://soundcloud.com/");
      const scripts = [...home.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
      for (const s of scripts.reverse()) {
        try {
          const js = await withTimeout(fetch(s, { headers: { "user-agent": UA } }).then((r) => r.text()), 15000);
          const m = js.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/);
          if (m) { sc2.id = m[1]; sc2.t = Date.now(); status.soundcloud = true; return m[1]; }
        } catch {}
      }
      throw new Error("couldn't find a soundcloud client id");
    })();
    sc2.pending.then(() => { sc2.pending = null; }, () => { sc2.pending = null; });
    return sc2.pending;
  }

  async function scGet(url, params = {}, retry = true) {
    const id = await scClientId();
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set("client_id", id);
    const r = await withTimeout(fetch(u, { headers: { "user-agent": UA, accept: "application/json" } }), 12000);
    if ((r.status === 401 || r.status === 403) && retry) { await scClientId(true); return scGet(url, params, false); }
    if (!r.ok) throw new Error("soundcloud answered " + r.status);
    status.soundcloud = true;
    return r.json();
  }

  async function searchSoundCloud(q) {
    const d = await withTimeout(scGet("https://api-v2.soundcloud.com/search/tracks", { q, limit: 15 }), 15000);
    const rows = (d?.collection || []).filter((t) => t && t.kind === "track" && t.policy !== "BLOCK" && t.policy !== "SNIP");
    return rows.slice(0, 10).map((t) => ({
      source: "soundcloud",
      id: t.permalink_url,
      title: t.title,
      artist: t.user?.username || "",
      thumb: (t.artwork_url || t.user?.avatar_url || "").replace("-large", "-t300x300"),
      dur: Math.round((t.duration || 0) / 1000),
    })).filter((t) => t.id);
  }

  /* ---- Audius: a free, open music network. Smaller catalog, but its audio comes straight from open servers ---- */
  const AUDIUS = "https://api.audius.co/v1";
  async function searchAudius(q) {
    const r = await withTimeout(fetch(`${AUDIUS}/tracks/search?query=${encodeURIComponent(q)}&limit=10&app_name=NexVelo`, { headers: { "user-agent": UA } }), 10000);
    if (!r.ok) throw new Error("audius answered " + r.status);
    const d = await r.json();
    status.audius = true;
    return (d?.data || []).filter((t) => t.id && t.is_streamable !== false).slice(0, 8).map((t) => ({
      source: "audius",
      id: String(t.id),
      title: t.title,
      artist: t.user?.name || "",
      thumb: t.artwork?.["480x480"] || t.artwork?.["150x150"] || "",
      dur: Math.round(t.duration || 0),
    }));
  }
  const audiusStream = (id) => `${AUDIUS}/tracks/${encodeURIComponent(id)}/stream?app_name=NexVelo`;

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
    const [a, b, c] = await Promise.allSettled([searchYouTube(q), searchSoundCloud(q), searchAudius(q)]);
    const errors = {};
    if (a.status === "rejected") errors.youtube = String(a.reason?.message || a.reason);
    if (b.status === "rejected") errors.soundcloud = String(b.reason?.message || b.reason);
    if (c.status === "rejected") errors.audius = String(c.reason?.message || c.reason);
    const all = [...(a.value || []), ...(b.value || []), ...(c.value || [])]
      .map((t) => ({ ...t, score: score(q, t) }))
      .filter((t) => t.source !== "audius" || t.score >= 0.25);
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

  // Pick a playable SoundCloud format: whole mp3 first, then an mp3 playlist. Opus/ogg are skipped (browsers can't join those pieces).
  async function scStreamUrl(id) {
    return cached("sc:" + id, async () => {
      const track = /^https?:/i.test(id)
        ? await scGet("https://api-v2.soundcloud.com/resolve", { url: id })
        : await scGet("https://api-v2.soundcloud.com/tracks/" + encodeURIComponent(id));
      const mimeOf = (t) => t.format?.mime_type || "";
      const rank = (t) => (t.format?.protocol === "progressive" ? 0 : 1) + (/mpeg/i.test(mimeOf(t)) ? 0 : 0.5);
      const good = (track?.media?.transcodings || [])
        .filter((t) => t.url && /mpeg|mp3|aac|mp4/i.test(mimeOf(t)) && !/opus|ogg/i.test(mimeOf(t)))
        .sort((a, b) => rank(a) - rank(b));
      if (!good.length) throw new Error("soundcloud has no playable format for this track");
      let lastErr = "";
      for (const t of good) {
        try {
          const u = new URL(t.url);
          u.searchParams.set("client_id", await scClientId());
          if (track.track_authorization) u.searchParams.set("track_authorization", track.track_authorization);
          const r = await withTimeout(fetch(u, { headers: { "user-agent": UA } }), 12000);
          if (!r.ok) { lastErr = "HTTP " + r.status; continue; }
          const d = await r.json();
          if (d?.url) return { url: d.url, hls: t.format?.protocol === "hls" };
        } catch (e) { lastErr = String(e?.message || e); }
      }
      throw new Error("soundcloud gave no stream" + (lastErr ? " (" + lastErr + ")" : ""));
    });
  }

  // HLS = a playlist of small audio files. For mp3/aac pieces, sending them one after another is a valid audio stream.
  async function prepareHls(m3u8Url) {
    const get = async (u) => {
      const r = await withTimeout(fetch(u, { headers: { "user-agent": UA } }), 15000);
      if (!r.ok) throw new Error("hls " + r.status);
      return r;
    };
    let base = m3u8Url, text = await (await get(base)).text();
    if (/#EXT-X-STREAM-INF/.test(text)) { // master playlist: take the first quality
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
    return { mime, firstBuf, segs, get };
  }

  function sendHls(p, reply) {
    async function* pieces() {
      yield p.firstBuf;
      for (let i = 1; i < p.segs.length; i++) yield Buffer.from(await (await p.get(p.segs[i])).arrayBuffer());
    }
    reply.code(200).header("content-type", p.mime).header("accept-ranges", "none").header("cache-control", "no-store");
    return reply.send(Readable.from(pieces()));
  }
  app.__streamHls = async (u, reply) => sendHls(await prepareHls(u), reply); // used by the tests

  // Public Piped servers can hand out YouTube audio when YouTube blocks this server directly (they come and go; set PIPED_INSTANCES to change the list)
  async function pipedUrl(id) {
    const bases = (process.env.PIPED_INSTANCES || "https://pipedapi.kavin.rocks,https://pipedapi.adminforge.de,https://api.piped.private.coffee").split(",").map((x) => x.trim()).filter(Boolean);
    try {
      return await Promise.any(bases.map(async (base) => {
        const r = await withTimeout(fetch(`${base}/streams/${id}`, { headers: { "user-agent": UA } }), 6000);
        if (!r.ok) throw new Error("piped " + r.status);
        const d = await r.json();
        const list = (d.audioStreams || []).filter((x) => x.url);
        const pick = list.filter((x) => /mp4|m4a|aac|mpeg/i.test(`${x.mimeType} ${x.format}`)).sort((x, y) => (y.bitrate || 0) - (x.bitrate || 0))[0] || list[0];
        if (!pick?.url) throw new Error("no audio");
        return pick.url;
      }));
    } catch { throw new Error("no piped server answered"); }
  }

  async function ytdlUrl(id) {
    const mod = await import("@distube/ytdl-core");
    const ytdl = [mod?.default?.default, mod?.default, mod].find((x) => typeof x === "function" || typeof x?.getInfo === "function");
    const info = await withTimeout(ytdl.getInfo(`https://www.youtube.com/watch?v=${id}`), 12000);
    const audio = info.formats.filter((f) => f.hasAudio && !f.hasVideo);
    const byRate = (a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0);
    const pick = audio.filter((f) => /mp4/.test(f.mimeType || "")).sort(byRate)[0] || audio.sort(byRate)[0];
    if (!pick?.url) throw new Error("no audio format found");
    return pick.url;
  }

  // Both ways are tried at the same time; whichever answers first wins.
  async function youtubeUrl(id) {
    return cached("yt:" + id, async () => {
      try { return await Promise.any([ytdlUrl(id), pipedUrl(id)]); }
      catch (e) {
        const why = (e.errors || []).map((x) => String(x?.message || x).slice(0, 80)).join("; ");
        throw new Error("youtube wouldn't give audio (" + why + ")");
      }
    });
  }

  async function bestSoundCloud(q) {
    const rows = await searchSoundCloud(q);
    return rows.map((t) => ({ ...t, score: score(q, t) })).sort((a, b) => b.score - a.score)[0] || null;
  }
  async function bestAudius(q) {
    const rows = await searchAudius(q);
    return rows.map((t) => ({ ...t, score: score(q, t) })).filter((t) => t.score >= 0.3).sort((a, b) => b.score - a.score)[0] || null;
  }

  async function openUp(url, range) {
    const up = await withTimeout(fetch(url, { headers: { "user-agent": UA, ...(range ? { range } : {}) }, redirect: "follow" }), 20000);
    if (!up.ok && up.status !== 206) throw new Error("upstream " + up.status);
    return up;
  }

  // Try the track itself, then the same song on the other sources. Each step must really start returning audio.
  async function resolveAudio(source, id, q, range) {
    const steps = [];
    const direct = (urlFn) => async () => ({ up: await openUp(await urlFn(), range) });
    const viaSc = (scId) => async () => {
      const f = await scStreamUrl(scId);
      return f.hls ? { hls: await prepareHls(f.url) } : { up: await openUp(f.url, range) };
    };
    if (source === "soundcloud") steps.push(["soundcloud", viaSc(id)]);
    else if (source === "audius") steps.push(["audius", direct(() => audiusStream(id))]);
    else steps.push(["youtube", direct(() => youtubeUrl(id))]);
    if (q) {
      if (source !== "soundcloud") steps.push(["soundcloud match", async () => {
        const alt = await bestSoundCloud(q); if (!alt) throw new Error("no match");
        return viaSc(alt.id)();
      }]);
      if (source !== "audius") steps.push(["audius match", async () => {
        const alt = await bestAudius(q); if (!alt) throw new Error("no match");
        return direct(() => audiusStream(alt.id))();
      }]);
    }
    const errs = [];
    for (const [name, fn] of steps) {
      try { return await fn(); }
      catch (e) { errs.push(name + ": " + String(e?.message || e).slice(0, 110)); }
    }
    throw new Error(errs.join(" | "));
  }

  app.get("/api/music/stream", async (req, reply) => {
    const source = String(req.query?.source || ""), id = String(req.query?.id || "");
    const q = String(req.query?.q || "").trim().slice(0, 140);
    if (!id || !["youtube", "soundcloud", "audius"].includes(source)) { reply.code(400); return { error: "bad request" }; }
    try {
      const got = await resolveAudio(source, id, q, req.headers.range);
      if (got.hls) return sendHls(got.hls, reply);
      const up = got.up;
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
      const best = await bestSoundCloud(q);
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
    for (let i = 0; i < RECOMMENDED.length; i += 4) { // four searches at a time
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
    if (list.length < 5) { // fall back to the links on the home page
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
    if (site === "gn" || site === "cherri" || site === "obsidian") {
      try {
        const games = await (site === "gn" ? gnGames() : site === "cherri" ? cherriGames() : obsidianGames());
        return { games, count: games.length, kind: "library" };
      }
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
     GN Math (GitHub, via jsDelivr), Cherri Games (GitLab) and Obsidian's Unblocked Revamped (GitHub, read straight from
     GitHub because the repo is too big for jsDelivr). Their files are served from here with the right content
     type, so a game's own pages, scripts and images load from one place (and through the proxy). */
  const FILE_MIME = { html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", js: "application/javascript; charset=utf-8", mjs: "application/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", wasm: "application/wasm", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", txt: "text/plain; charset=utf-8", xml: "application/xml" };
  const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
  const OBS = { owner: "Obsidian-ig", repo: "ObsidiansUnblockedRevamped", branch: "main2" };
  const LIB_RAW = {
    cherri: (p) => `https://gitlab.com/x8r/cherrigames/-/raw/main/${encPath(p)}`,
    gnhtml: (p) => `https://cdn.jsdelivr.net/gh/gn-math/html@main/${encPath(p)}`,
    gnassets: (p) => `https://cdn.jsdelivr.net/gh/gn-math/assets@main/${encPath(p)}`,
    gncovers: (p) => `https://cdn.jsdelivr.net/gh/gn-math/covers@main/${encPath(p)}`,
    obsidian: (p) => `https://raw.githubusercontent.com/${OBS.owner}/${OBS.repo}/${OBS.branch}/${encPath(p)}`,
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

  // Obsidian's Unblocked Revamped (archived GitHub repo). Only its games/ folder is read, one folder per game.
  async function obsidianGames() {
    return cached("obsidian:list", async () => {
      const headers = { "user-agent": UA, accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { authorization: "Bearer " + process.env.GITHUB_TOKEN } : {}) };
      const gh = async (path) => {
        const r = await withTimeout(fetch(`https://api.github.com/repos/${OBS.owner}/${OBS.repo}/${path}`, { headers }), 25000);
        if (!r.ok) throw new Error("GitHub answered " + r.status + (r.status === 403 ? " (rate limit: add a GITHUB_TOKEN variable on the server)" : ""));
        return r.json();
      };
      const root = await gh("git/trees/" + OBS.branch);
      const folder = (root.tree || []).find((x) => x.path === "games" && x.type === "tree");
      if (!folder) throw new Error("the Obsidian repo has no games folder");
      const files = ((await gh("git/trees/" + folder.sha + "?recursive=1")).tree || []).filter((x) => x.type === "blob").map((x) => x.path);
      const groups = {}, loose = [];
      for (const p of files) {
        const i = p.indexOf("/");
        if (i < 0) { if (/\.html?$/i.test(p)) loose.push(p); continue; }
        (groups[p.slice(0, i)] ||= []).push(p);
      }
      const enc = (p) => "/api/games/f/obsidian/" + encPath("games/" + p);
      const games = [];
      for (const [dir, list] of Object.entries(groups)) {
        const htmls = list.filter((f) => /\.html?$/i.test(f)).sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);
        const play = list.find((f) => f.toLowerCase() === dir.toLowerCase() + "/index.html") || htmls[0];
        if (!play) continue;
        const imgs = list.filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f) && f.split("/").length <= 3);
        const thumb = imgs.find((f) => /(thumb|icon|cover|logo|preview|banner|splash|image)/i.test(f)) || imgs[0] || "";
        games.push({ name: titleCase(dir), play: enc(play), thumb: thumb ? enc(thumb) : "" });
      }
      for (const p of loose) games.push({ name: titleCase(p.replace(/\.html?$/i, "")), play: enc(p), thumb: "" });
      if (!games.length) throw new Error("no games found in the Obsidian repo's games folder (" + files.length + " files looked at)");
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
    const H = { headers: { "user-agent": "Nex.Velo (https://github.com/Nex-Mav/Nex.Velo)" } };
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

  /* ================= AI chat: Nex.AI =================
     Nex.AI is always the answerer: a small open-source model (Qwen) that runs on this server. No outside AI company, no key.
     It can look facts up on Wikipedia first, so it answers from real sources instead of guessing.
     Optional safety nets, only if the server owner sets GROQ_API_KEY: (1) if the built-in model can't start, the answer
     is still given (and still called Nex.AI), and (2) images/screens can be described. */
  const AI_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
  const VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
  const LOCAL_MODEL = process.env.NEXAI_MODEL || "onnx-community/Qwen2.5-0.5B-Instruct";
  const aiKey = (req) => String(req.headers["x-groq-key"] || process.env.GROQ_API_KEY || "").trim();

  let local = { gen: null, T: null, loading: null, last: 0, error: "", progress: "", queue: Promise.resolve() };

  async function memoryOk() {
    try {
      const fs = await import("node:fs");
      for (const p of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
        try {
          const v = fs.readFileSync(p, "utf8").trim(), lim = Number(v);
          if (v && v !== "max" && lim > 0 && lim < 1.3e9) return false; // the model needs about 1.2 GB
        } catch {}
      }
    } catch {}
    return true;
  }

  function getLocal() {
    if (local.gen) return Promise.resolve(local.gen);
    if (!local.loading) {
      local.progress = "";
      local.loading = (async () => {
        if (!(await memoryOk())) throw new Error("this server doesn't have enough memory for the built-in model (it needs about 1.5 GB)");
        const name = "@huggingface/" + "transformers"; // built from pieces so Vercel doesn't bundle the model runtime. It only runs on the Nex.Velo server.
        let T;
        try { T = await import(name); } catch { throw new Error("the built-in model isn't installed on this host (it runs on the Nex.Velo server)"); }
        T.env.cacheDir = process.env.NEXAI_CACHE || "/tmp/nexai"; T.env.allowLocalModels = false;
        local.gen = await T.pipeline("text-generation", LOCAL_MODEL, {
          dtype: "q4",
          progress_callback: (p) => { if (p && p.status === "progress" && typeof p.progress === "number") local.progress = Math.round(p.progress) + "%"; },
        });
        local.T = T; local.error = ""; local.progress = ""; local.last = Date.now();
        console.log("[nex.ai] model ready:", LOCAL_MODEL);
        return local.gen;
      })().catch((e) => { local.loading = null; local.error = String(e?.message || e); console.warn("[nex.ai] could not load:", local.error); throw e; });
    }
    return local.loading;
  }

  setInterval(async () => { // free the memory when nobody has used the model for ten minutes
    if (local.gen && Date.now() - local.last > 10 * 60 * 1000) { try { await local.gen.dispose?.(); } catch {} local.gen = null; local.loading = null; }
  }, 60 * 1000).unref?.();

  app.get("/api/ai/status", async (req) => {
    if (req.query?.wake && !process.env.VERCEL && !local.gen && !local.loading) getLocal().catch(() => {}); // start loading as soon as the AI tab opens
    return {
      canRun: !process.env.VERCEL, ready: !!local.gen, loading: !!local.loading && !local.gen, progress: local.progress, error: local.error,
      model: LOCAL_MODEL, vision: !!process.env.GROQ_API_KEY, serverKey: !!process.env.GROQ_API_KEY,
    };
  });

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
    let convo = flat.filter((m) => m.role !== "system").slice(-10), total = 0; // a small model does best with a short conversation
    convo = convo.reverse().filter((m) => (total += m.content.length) < 6500).reverse();
    const lastUser = [...convo].reverse().find((m) => m.role === "user");

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*", "x-model": "nex-ai-local" });
    const send = (text) => { if (!closed) raw.write("data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n"); };
    const note = (text) => { if (!closed) raw.write("data: " + JSON.stringify({ status: text }) + "\n\n"); };
    let stop = null, closed = false;
    // watch the response (the connection), not the request: the request "closes" as soon as its body has been read
    raw.on("close", () => { if (!raw.writableEnded) { closed = true; try { stop?.interrupt(); } catch {} } });

    const turn = local.queue.then(async () => {
      try {
        let facts = "";
        if (web && lastUser && looksLikeQuestion(lastUser.content)) facts = await wikiFacts(lastUser.content);
        const system = { role: "system", content: sys.content + (facts ? "\n\nFacts from Wikipedia. Use them if they help, and say when you are not sure:\n" + facts : "") };

        let gen = local.gen;
        if (!gen) {
          const tick = setInterval(() => note(local.progress ? "waking up Nex.AI… downloading its model " + local.progress : "waking up Nex.AI… the first answer after a quiet spell can take a few minutes"), 2500);
          let giveUp;
          try {
            gen = await Promise.race([
              getLocal(),
              new Promise((_, rej) => { giveUp = setTimeout(() => rej(new Error("Nex.AI is still loading its model on the server. wait a minute or two and ask again.")), 5 * 60 * 1000); }),
            ]);
          } finally { clearInterval(tick); clearTimeout(giveUp); }
        }
        if (closed) return;
        local.last = Date.now();
        const T = local.T; stop = new T.InterruptableStoppingCriteria();
        const limit = setTimeout(() => { try { stop.interrupt(); } catch {} }, 3 * 60 * 1000); // never run forever
        const streamer = new T.TextStreamer(gen.tokenizer, { skip_prompt: true, skip_special_tokens: true, callback_function: (t) => send(t) });
        try {
          await gen([system, ...convo], { max_new_tokens: 600, do_sample: true, temperature: 0.7, top_p: 0.9, repetition_penalty: 1.1, streamer, stopping_criteria: stop });
        } finally { clearTimeout(limit); }
        local.last = Date.now();
      } catch (e) {
        console.warn("[nex.ai]", String(e?.message || e));
        const key = process.env.GROQ_API_KEY;
        if (key && !closed) { // optional safety net: still answer as Nex.AI
          try {
            const up = await fetch("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
              body: JSON.stringify({ model: AI_MODELS[1], messages, stream: true, temperature: 0.7, max_tokens: 2048 }),
            });
            if (!up.ok) throw new Error("backup answered " + up.status);
            for await (const chunk of Readable.fromWeb(up.body)) { if (closed) break; raw.write(chunk); }
            return;
          } catch (e2) { send("⚠️ " + String(e?.message || e)); return; }
        }
        send("⚠️ " + String(e?.message || e));
      }
    });
    local.queue = turn.catch(() => {});
    await turn;
    if (!closed && !raw.writableEnded) { raw.write("data: [DONE]\n\n"); raw.end(); }
    return reply;
  }

  app.post("/api/ai/chat", async (req, reply) => {
    const body = req.body || {};
    const { messages, hasImage } = cleanMessages(body.messages);
    if (!messages.length) { reply.code(400); return { error: "no messages" }; }
    if (!hasImage) return localChat(req, reply, messages, body.web !== false);

    // Images and screen shares need a vision model, which only runs if the server owner added a key.
    const key = aiKey(req);
    if (!key) { reply.code(400); return { error: "vision_unavailable" }; }
    try {
      const up = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: VISION_MODEL, messages, stream: true, temperature: 0.7, max_tokens: 4096 }),
      });
      if (!up.ok) { const t = await up.text(); reply.code(up.status); return { error: t.slice(0, 400), model: VISION_MODEL }; }
      reply.header("content-type", "text/event-stream").header("cache-control", "no-cache").header("x-model", "nex-ai-vision");
      return reply.send(Readable.fromWeb(up.body));
    } catch (e) { reply.code(502); return { error: String(e?.message || e) }; }
  });

  /* ================= Diagnostics: open /api/diag in a browser to see exactly which outside service is failing ================= */
  app.get("/api/diag", async () => {
    const t = async (fn) => {
      const s = Date.now();
      try { const info = await withTimeout(fn(), 30000); return { ok: true, ms: Date.now() - s, info }; }
      catch (e) { return { ok: false, ms: Date.now() - s, error: String(e?.message || e).slice(0, 240) }; }
    };
    const names = ["youtubeSearch", "youtubeAudio", "soundcloudSearch", "soundcloudAudio", "audiusSearch", "audiusAudio", "gnMath", "cherri", "obsidian", "duckmath", "weslack", "huggingface", "wikipedia"];
    const jobs = [
      t(async () => (await searchYouTube("blinding lights the weeknd")).length + " results"),
      t(async () => { const u = await youtubeUrl("dQw4w9WgXcQ"); return u ? "got an audio link" : ""; }),
      t(async () => (await searchSoundCloud("blinding lights the weeknd")).length + " results"),
      t(async () => { const r = (await searchSoundCloud("lofi hip hop"))[0]; if (!r) throw new Error("no search result to test"); const f = await scStreamUrl(r.id); return f.hls ? "playlist stream" : "direct stream"; }),
      t(async () => (await searchAudius("lofi")).length + " results"),
      t(async () => { const r = (await searchAudius("lofi"))[0]; if (!r) throw new Error("no search result to test"); const up = await openUp(audiusStream(r.id)); try { up.body.cancel(); } catch {} return "audio " + (up.headers.get("content-type") || ""); }),
      t(async () => (await gnGames()).length + " games"),
      t(async () => (await cherriGames()).length + " games"),
      t(async () => (await obsidianGames()).length + " games"),
      t(async () => { const g = await siteGames("duckmath"); if (!g.list.length) throw new Error(g.tried.join("; ") || "no games found"); return g.list.length + " games"; }),
      t(async () => { const g = await siteGames("weslack"); if (!g.list.length) throw new Error(g.tried.join("; ") || "no games found"); return g.list.length + " games"; }),
      t(async () => { const r = await withTimeout(fetch("https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct/resolve/main/config.json", { headers: { "user-agent": UA } }), 15000); if (!r.ok) throw new Error("HTTP " + r.status); return "reachable (the AI model downloads from here)"; }),
      t(async () => { const r = await wikiFacts("What is the moon?"); if (!r) throw new Error("no answer"); return "ok"; }),
    ];
    const done = await Promise.all(jobs);
    const checks = {}; names.forEach((n, i) => { checks[n] = done[i]; });
    const mem = process.memoryUsage();
    return {
      node: process.version, rssMB: Math.round(mem.rss / 1e6), enoughMemoryForModel: await memoryOk(),
      nexAi: { ready: !!local.gen, loading: !!local.loading && !local.gen, progress: local.progress, error: local.error, model: LOCAL_MODEL },
      checks,
    };
  });

  // Warm up the music sources in the background so the first search is quick.
  ensureYT().catch(() => {});
  scClientId().catch((e) => console.warn("SoundCloud unavailable:", e?.message || e));
}
