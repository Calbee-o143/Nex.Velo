import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
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
