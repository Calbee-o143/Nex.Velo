(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const LS = {
get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
const VERSION = "0.99.11";
// small icons of our own (used instead of text symbols)
const ICON_X = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l4-1 11-11-3-3L5 16z"/></svg>';

// The API (AI, music, lyrics...) lives on the Nex.Velo server. Ask this host first, then the Railway server.
const _fetch = window.fetch.bind(window);
let API = "";
const apiReady = (async () => {
if (/\.railway\.app$/i.test(location.hostname) || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
const probe = async (base) => {
try {
const c = new AbortController(), t = setTimeout(() => c.abort(), 3500);
const r = await _fetch(base + "/api/ai/status", { signal: c.signal }); clearTimeout(t);
return r.ok && !!(await r.json());
} catch { return false; }
};
for (const base of ["", "https://nex-velo.up.railway.app"]) if (await probe(base)) { API = base; return; }
API = "https://nex-velo.up.railway.app"; // nothing answered: keep the default so the errors point at the right place
})();
window.fetch = (u, o) => (typeof u === "string" && u.startsWith("/api/") ? apiReady.then(() => _fetch(API + u, o)) : _fetch(u, o));

/* ================= Settings ================= */
const defaultWisp = "wss://nex-velo.up.railway.app/wisp/"; // the Nex.Velo server, always available as the default
const settings = {
wisp: defaultWisp, engine: "https://duckduckgo.com/?q=%s", adblock: true,
theme: "black", wall: "none", wallUrl: "", blur: true, blurAmt: 14,
clock: true, h24: true, music: true, games: true, ai: true, name: "",
launch: "ask", launchRedirect: true, wispAuto: true,
custom: { bg: "#14161a", fg: "#f2f2f2", accent: "#8ab4ff", clock: "", bar: "", font: "jetbrains", size: 100 },
panicOn: true, panicKey: "F9", panicSite: "classroom", panicUrl: "", panicMode: "replace",
};
try { Object.assign(settings, JSON.parse(LS.get("nexvelo.settings", "{}"))); } catch {}
if (LS.get("nexvelo.settings") == null) { // carry over values saved by the first version
const w = LS.get("nexus.wisp"), e = LS.get("nexus.engine"), a = LS.get("nexus.adblock");
if (w) settings.wisp = w;
if (e) settings.engine = e;
if (a != null) settings.adblock = a === "1";
}
const PANIC_SITES = {
classroom: "https://classroom.google.com", docs: "https://docs.google.com", drive: "https://drive.google.com", gmail: "https://mail.google.com",
canvas: "https://canvas.instructure.com", schoology: "https://app.schoology.com", khan: "https://www.khanacademy.org",
desmos: "https://www.desmos.com/calculator", wikipedia: "https://www.wikipedia.org", google: "https://www.google.com",
};
{ // an address saved by the earlier version stays as "my own address"
let saved = {}; try { saved = JSON.parse(LS.get("nexvelo.settings", "{}")); } catch {}
if (!saved.panicSite && saved.panicUrl && !Object.values(PANIC_SITES).includes(saved.panicUrl)) settings.panicSite = "custom";
else if (!saved.panicSite && saved.panicUrl) settings.panicSite = Object.keys(PANIC_SITES).find((k) => PANIC_SITES[k] === saved.panicUrl) || "classroom";
}
const panicDest = () => (settings.panicSite === "custom" ? settings.panicUrl : PANIC_SITES[settings.panicSite]) || PANIC_SITES.classroom;
const save = () => LS.set("nexvelo.settings", JSON.stringify(settings));

/* ================= Banner (shows what is wrong instead of a blank page) ================= */
function showBanner(msg) {
const b = $("#banner"); if (!b) return;
b.innerHTML = `<span>${esc(msg)}</span><button type="button" aria-label="Dismiss">${ICON_X}</button>`;
b.hidden = false; $("button", b).onclick = () => { b.hidden = true; };
}
addEventListener("error", (e) => { // a script that couldn't be loaded at all (missing file)
const t = e.target; if (t && t.tagName === "SCRIPT") showBanner("couldn't load " + (t.getAttribute("src") || "a file").split("?")[0] + ". upload it to the public folder and refresh.");
}, true);

/* ================= Toast + spring ================= */
let toastTimer;
function toast(msg) {
const t = $("#toast");
t.textContent = msg; t.classList.add("on");
clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 3200);
}
// Critically damped by default (no overshoot). Starts from the live value, so it can be interrupted.
function spring({ from, to, velocity = 0, response = .35, damping = 1 }, onUpdate, onDone) {
if (reduceMotion()) { onUpdate(to); onDone && onDone(); return () => {}; }
const k = (2 * Math.PI / response) ** 2, c = 4 * Math.PI * damping / response;
let x = from, v = velocity, last = performance.now(), raf, dead = false;
const step = (now) => {
if (dead) return;
const dt = Math.min((now - last) / 1000, 1 / 30); last = now;
const n = Math.max(1, Math.ceil(dt * 240));
for (let i = 0; i < n; i++) { const h = dt / n; v += (-k * (x - to) - c * v) * h; x += v * h; }
onUpdate(x);
if (Math.abs(x - to) < .002 && Math.abs(v) < .02) { onUpdate(to); onDone && onDone(); return; }
raf = requestAnimationFrame(step);
};
raf = requestAnimationFrame(step);
return () => { dead = true; cancelAnimationFrame(raf); };
}

/* ================= Scramjet + transport ================= */
const { ScramjetController } = $scramjetLoadController();
const scramjet = new ScramjetController({
prefix: "/scramjet/",
files: { wasm: "/scram/scramjet.wasm.wasm", all: "/scram/scramjet.all.js", sync: "/scram/scramjet.sync.js" },
codec: { encode: (u) => encodeURIComponent(u), decode: (u) => decodeURIComponent(u) },
flags: { captureErrors: true, strictRewrites: true, sourcemaps: true, allowInvalidJs: true, allowFailedIntercepts: true },
});
const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
let activeWisp = settings.wisp; // the server in use right now (may differ from the saved one if that one is down)
const applyTransport = () => connection.setTransport("/libcurl/index.mjs", [{ wisp: activeWisp, websocket: activeWisp }]);
async function pickWisp() {
if (settings.wispAuto === false) return;
const sameHost = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
for (const u of [...new Set([settings.wisp, defaultWisp, sameHost])]) {
if (await testWisp(u, 4500)) {
if (u !== settings.wisp) { activeWisp = u; toast("your Wisp server wasn't reachable, using " + new URL(u).host + " instead"); }
return;
}
}
showBanner("no Wisp server could be reached, so sites won't load. open Settings → servers and add one that is running.");
}
async function pushAdblock() {
const reg = await navigator.serviceWorker.ready;
(reg.active || navigator.serviceWorker.controller)?.postMessage({ type: "adblock", enabled: settings.adblock });
}
const ready = (async () => {
if (!("serviceWorker" in navigator)) throw new Error("Service workers aren't supported in this browser.");
await scramjet.init(); // create Scramjet's database before the service worker starts
await navigator.serviceWorker.register("/sw.js", { scope: "/" });
await navigator.serviceWorker.ready;
await pickWisp();
await applyTransport();
await pushAdblock();
})();
ready.catch((e) => console.error("Proxy setup failed:", e));

/* ================= Clock ================= */
const greet = (h) => (h < 5 ? "good night" : h < 12 ? "good morning" : h < 18 ? "good afternoon" : h < 22 ? "good evening" : "good night");
function tickClock() {
const d = new Date(), h = d.getHours();
const hh = settings.h24 ? String(h).padStart(2, "0") : String(h % 12 || 12).padStart(2, "0");
const parts = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).formatToParts(d);
const g = (t) => parts.find((p) => p.type === t)?.value || "";
const date = `${g("weekday")} ${g("day")} ${g("month")}`.toLowerCase();
const hello = greet(h) + (settings.name ? `, ${settings.name.toLowerCase()}` : "");
$("#bar-clock").textContent = `${hh}:${String(d.getMinutes()).padStart(2, "0")}`;
for (const el of $$(".clock")) {
el.hidden = !settings.clock;
$(".h", el).textContent = hh;
$(".m", el).textContent = String(d.getMinutes()).padStart(2, "0");
$(".g", el).innerHTML = `<b>${esc(hello)}</b> · ${esc(date)}`;
}
}
setInterval(tickClock, 1000);

/* ================= Themes + wallpapers ================= */
const THEMES = [["black", "midnight", "#0a0a0b"], ["white", "paper", "#f6f6f4"], ["sage", "sage", "#c9dcc0"], ["lavender", "lavender", "#d4c9ec"], ["rose", "rose", "#f2c6cd"], ["sky", "sky", "#c3dcf2"], ["peach", "peach", "#f6d2b8"], ["custom", "custom", "#888"]];
const WALLS = { none: null, forest: () => NVWalls.forest(), ocean: () => NVWalls.ocean(), sky: () => NVWalls.sky() };
const wallCache = {};
const wallData = () => LS.get("nexvelo.wallpaper", "");
const wallSrc = (k) => (k === "custom" ? wallData() || settings.wallUrl : (wallCache[k] ??= WALLS[k] ? WALLS[k]() : null));

/* ----- custom theme: colours, fonts, size ----- */
const FONTS = {
jetbrains: ["JetBrains Mono", '"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace', "JetBrains+Mono:wght@300;400;500;700"],
inter: ["Inter", 'Inter,system-ui,sans-serif', "Inter:wght@300;400;500;700"],
poppins: ["Poppins", 'Poppins,system-ui,sans-serif', "Poppins:wght@300;400;500;700"],
space: ["Space Grotesk", '"Space Grotesk",system-ui,sans-serif', "Space+Grotesk:wght@300;400;500;700"],
dm: ["DM Sans", '"DM Sans",system-ui,sans-serif', "DM+Sans:wght@300;400;500;700"],
quicksand: ["Quicksand", 'Quicksand,system-ui,sans-serif', "Quicksand:wght@300;400;500;700"],
playfair: ["Playfair Display", '"Playfair Display",Georgia,serif', "Playfair+Display:wght@400;500;700"],
lora: ["Lora", 'Lora,Georgia,serif', "Lora:wght@400;500;700"],
system: ["System", 'system-ui,-apple-system,"Segoe UI",sans-serif', null],
serif: ["Georgia (serif)", 'Georgia,"Times New Roman",serif', null],
mono: ["Courier (mono)", '"Courier New",ui-monospace,monospace', null],
};
const loadedFonts = new Set(["jetbrains"]);
function loadFont(k) {
const f = FONTS[k]; if (!f || !f[2] || loadedFonts.has(k)) return;
loadedFonts.add(k);
const l = document.createElement("link"); l.rel = "stylesheet"; l.href = `https://fonts.googleapis.com/css2?family=${f[2]}&display=swap`;
document.head.appendChild(l);
}
const lum = (hex) => { const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
const contrastOn = (hex) => (lum(hex) > .4 ? "#101010" : "#ffffff");
const CUSTOM_VARS = ["--bg", "--fg", "--dim", "--panel", "--card", "--accent", "--accent-fg", "--clock", "--bar", "--font", "--fs"];
function applyTheme() {
const root = document.documentElement;
root.dataset.theme = settings.theme;
CUSTOM_VARS.forEach((v) => root.style.removeProperty(v));
root.style.colorScheme = "";
if (settings.theme !== "custom") return;
const c = settings.custom, set = (k, v) => root.style.setProperty(k, v);
set("--bg", c.bg); set("--fg", c.fg); set("--panel", c.bg);
set("--dim", `color-mix(in srgb, ${c.fg} 58%, transparent)`);
set("--card", `color-mix(in srgb, ${c.fg} 9%, ${c.bg})`);
set("--accent", c.accent); set("--accent-fg", contrastOn(c.accent));
if (c.clock) set("--clock", c.clock);
if (c.bar) set("--bar", c.bar);
const f = FONTS[c.font] || FONTS.jetbrains; loadFont(c.font); set("--font", f[1]);
set("--fs", c.size + "%");
root.style.colorScheme = lum(c.bg) > .4 ? "light" : "dark";
}
function applyWall() {
let src = wallSrc(settings.wall);
if (settings.wall === "custom" && !/^(https?:|data:image\/)/i.test(src || "")) src = null;
$("#wall").style.backgroundImage = src ? `url("${src.replace(/"/g, "%22")}")` : "";
$("#wall").style.setProperty("--blur", settings.blur ? settings.blurAmt + "px" : "0px");
document.body.classList.toggle("has-wall", !!src);
}

/* ================= Escape key (the panic key) ================= */
let capturing = false; // true while Settings is waiting for you to press the new key
// Returns true when the key was the panic key and the jump happened. Games and other frames call this too.
function panicHandler(e) {
if (capturing || !settings.panicOn || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return false;
const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
if (k !== settings.panicKey) return false;
const t = e.target, typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
if (typing && settings.panicKey.length === 1) return false; // single letters would fire while typing
e.preventDefault(); e.stopPropagation();
const dest = panicDest();
const top = (() => { try { return window.top.location.href, window.top; } catch { return window; } })();
if (settings.panicMode === "new") { window.open(dest, "_blank", "noopener"); top.location.replace("about:blank"); }
else top.location.replace(dest);
return true;
}
addEventListener("keydown", panicHandler, true);

/* ================= URL handling ================= */
const ALIAS = /^(?:https?:\/\/)?nex\.?velo(?:\/(?:games|music|ai|settings|servers)(?:\/[a-z0-9-]+)?)?\/?$/i;
function resolve(raw) {
const v = raw.trim();
if (!v) return null;
if (/^nex\.?velo\//i.test(v) && !ALIAS.test(v)) return location.origin + "/" + v.replace(/^nex\.?velo\/?/i, "");
if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
if (!/\s/.test(v) && (/^localhost(:\d+)?(\/|$)/i.test(v) || /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/|$|\?|#)/i.test(v))) return "https://" + v;
return settings.engine.replace("%s", encodeURIComponent(v));
}

/* ================= Loader (slanted bars + percentage + rotating quote) ================= */
const QUOTES = [
"Slow is smooth, smooth is fast.", "Patience.", "Good things take a moment.", "Almost there.",
"The best way out is always through.", "Small steps add up to big journeys.", "Breathe in, breathe out.",
"Every expert was once a beginner.", "Stay curious.", "Quiet minds find clear answers.",
"Nothing worth having arrives instantly.", "Keep going, you are closer than you think.",
"A little progress each day adds up to big results.", "Rest your eyes for a second.",
"You miss every shot you never take.", "Make it simple, then make it better.",
"The journey is the fun part.", "Loading greatness.", "Fortune favours the bold.",
"Be kind to your future self.", "Dream big, start small, begin now.", "Calm seas never made a skilled sailor.",
"Think different, load faster.", "Take a sip of water while you wait.", "Today is a good day to learn something new.",
"Courage is just fear that has said its prayers.", "Wherever you go, go with all your heart.",
"Light travels faster than sound, so some people look bright until they speak.",
"If you can dream it, you can build it.", "Hold tight, the page is on its way.",
];
const BARS = 24, words = (q) => q.trim().split(/\s+/).length;
let deck = [];
const nextQuoteText = () => { if (!deck.length) deck = [...QUOTES].sort(() => Math.random() - .5); return deck.pop(); };
function ensureLoader(t) {
if (t.loader) return t.loader;
const el = document.createElement("div");
el.className = "loader out"; el.hidden = true;
el.innerHTML = `<p class="lq"></p><div class="lrow"><div class="lbars">${"<i></i>".repeat(BARS)}</div><span class="lpct">0%</span></div>`;
t.view.appendChild(el);
return (t.loader = { el, q: $(".lq", el), bars: $$("i", el), pct: $(".lpct", el), p: 0, target: 0, creep: false, raf: 0, timer: 0, on: false });
}
function showQuote(L) {
if (!L.on) return;
const text = nextQuoteText();
L.q.classList.add("fade");
setTimeout(() => { L.q.textContent = text; L.q.classList.remove("fade"); }, L.q.textContent ? 300 : 0);
L.timer = setTimeout(() => showQuote(L), words(text) * 2000); // 1 word = 2 seconds
}
function loaderTick(L) {
if (!L.on) return;
if (L.creep && L.target < 92) L.target += .03;
L.p += (L.target - L.p) * .07 + .02;
if (L.p > L.target) L.p = L.target;
const lit = Math.floor((L.p / 100) * BARS + (L.p >= 99.5 ? 1 : 0));
L.bars.forEach((b, i) => b.classList.toggle("on", i < lit));
L.pct.textContent = Math.floor(L.p) + "%";
if (L.target >= 100 && L.p >= 99.4) { setTimeout(() => loaderStop(L), 250); return; }
L.raf = requestAnimationFrame(() => loaderTick(L));
}
function loaderStart(t) {
const L = ensureLoader(t);
cancelAnimationFrame(L.raf); clearTimeout(L.timer);
Object.assign(L, { on: true, p: 0, target: 15, creep: false });
L.bars.forEach((b) => b.classList.remove("on")); L.q.textContent = "";
L.el.hidden = false; requestAnimationFrame(() => L.el.classList.remove("out"));
showQuote(L); loaderTick(L);
clearTimeout(L.guard); L.guard = setTimeout(() => loaderStop(L), 60000); // never get stuck
}
function loaderStop(L) {
if (!L || !L.on) return;
L.on = false; cancelAnimationFrame(L.raf); clearTimeout(L.timer); clearTimeout(L.guard);
L.el.classList.add("out"); setTimeout(() => { if (!L.on) L.el.hidden = true; }, 320);
}

/* ================= Tabs ================= */
// kinds: "web" (home page or a proxied site), "settings", "games", "music", "ai"
const tabs = [];
let active = null, uid = 0, restoring = false;
const PAGES = { settings: $("#page-settings"), music: $("#page-music"), ai: $("#page-ai"), games: $("#page-games") };
const X_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const isHome = (t) => t.kind === "web" && !t.frame;

function saveTabs() {
if (restoring) return;
LS.set("nexvelo.tabs", JSON.stringify({ a: tabs.indexOf(active), t: tabs.map((t) => ({ k: t.kind, u: t.frame ? t.url : t.pendingUrl || "" })) }));
}

function newTab(opts = {}) {
const kind = opts.kind || "web";
if (kind !== "web" && !PAGES[kind]) { showBanner("the " + kind + " page isn't in this index.html. upload the newest index.html and clear the CDN cache."); return null; }
const t = { id: ++uid, kind, title: kind === "web" ? "New tab" : kind, url: "", frame: null, pendingUrl: null, loader: null };
t.view = document.createElement("div");
t.view.className = "view";
if (kind === "web") {
t.view.innerHTML = `<div class="home"><div class="clock"><div class="time"><span class="h"></span><i>:</i><span class="m"></span></div><div class="g"></div></div><form class="omni" onsubmit="return false"><input type="text" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="Search or enter address" aria-label="Search or enter address"></form><div class="marks"></div></div>`;
t.input = $("input", t.view);
$("form", t.view).addEventListener("submit", (e) => { e.preventDefault(); go(t, t.input.value); });
} else {
t.view.classList.add("has-page"); t.view.appendChild(PAGES[kind]);
}
t.chip = document.createElement("div");
t.chip.className = "tab"; t.chip.setAttribute("role", "tab");
t.chip.innerHTML = `<span class="t"></span><button class="x" aria-label="Close tab">${X_SVG}</button>`;
t.chip.addEventListener("pointerdown", (e) => { if (!e.target.closest(".x")) select(t); });
$(".x", t.chip).addEventListener("click", (e) => { e.stopPropagation(); closeTab(t); });
tabs.push(t);
$("#tabs").appendChild(t.chip);
$("#views").appendChild(t.view);
if (opts.url && opts.lazy) { t.pendingUrl = opts.url; t.title = hostOf(opts.url); }
paintChip(t); select(t); tickClock(); renderMarks();
if (kind === "settings") loadSettingsUI();
if (kind === "ai" && NV.onAiOpen) NV.onAiOpen();
if (kind === "games" && NV.onGamesOpen) NV.onGamesOpen();
if (opts.url && !opts.lazy) go(t, opts.url);
else if (kind === "web" && !opts.lazy) t.input.focus({ preventScroll: true });
return t;
}

const paintChip = (t) => { $(".t", t.chip).textContent = t.title; t.chip.title = t.title; };

function select(t) {
active = t;
for (const x of tabs) { const on = x === t; x.view.classList.toggle("active", on); x.chip.setAttribute("aria-selected", on); }
t.chip.scrollIntoView({ inline: "nearest", block: "nearest" });
if (t.pendingUrl && !restoring) { const u = t.pendingUrl; t.pendingUrl = null; go(t, u); }
syncChrome(); saveTabs();
window.NV && NV.onTab && NV.onTab(t);
}

function closeTab(t) {
const i = tabs.indexOf(t), wasActive = active === t;
if (t.loader) loaderStop(t.loader);
tabs.splice(i, 1);
t.chip.classList.add("closing"); t.view.classList.remove("active"); t.view.classList.add("leaving");
setTimeout(() => { // let the close animation play, then clean up
const node = PAGES[t.kind];
if (node && node.parentNode === t.view) $("#pages").appendChild(node);
t.chip.remove(); t.view.remove();
}, reduceMotion() ? 0 : 190);
if (!tabs.length) return newTab();
if (wasActive) select(tabs[Math.min(i, tabs.length - 1)]); else saveTabs();
}

function openPage(kind) {
if (!PAGES[kind]) return showBanner("the " + kind + " page isn't in this index.html. upload the newest index.html and clear the CDN cache.");
const ex = tabs.find((t) => t.kind === kind);
if (ex) { select(ex); if (kind === "settings") loadSettingsUI(); } else newTab({ kind });
}

/* ----- addresses like Nex.Velo/Music/Playlists: shown in the address bar, and typed to jump straight there ----- */
const KIND_LABEL = { music: "Music", games: "Games", ai: "AI", settings: "Settings" };
const titleSlug = (s) => s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("-");
function currentSub(kind) {
if (kind === "music") return $("#page-music .mtabs .on")?.dataset.mt || "";
if (kind === "games") { const k = $("#gtabs .on")?.dataset.g || ""; return k === "gn" ? "gn-math" : k; }
if (kind === "settings") { const s = $(".snav .nb.on")?.dataset.sec || ""; return s === "extensions" ? "apps" : s; }
return "";
}
const pageAddress = (kind) => "Nex.Velo/" + (KIND_LABEL[kind] || titleSlug(kind)) + (currentSub(kind) ? "/" + titleSlug(currentSub(kind)) : "");

function openSub(app, sub) {
sub = sub.toLowerCase();
if (app === "music" && ["search", "playlists", "recent"].includes(sub)) NV.musicShowTab && NV.musicShowTab(sub);
else if (app === "games") {
const k = sub === "gn-math" || sub === "gnmath" ? "gn" : sub;
if (["cherri", "gn", "duckmath", "weslack"].includes(k)) NV.gamesShowSource && NV.gamesShowSource(k, true);
} else if (app === "settings") {
const id = sub === "apps" ? "extensions" : sub;
if ($("#sec-" + id)) showSec(id);
}
}

// Returns true when the text was an address of one of our own pages (so nothing else should happen with it)
function routeAlias(raw) {
const m = String(raw).trim().match(/^(?:https?:\/\/)?nex\.?velo(?:\/([a-z]+))?(?:\/([a-z0-9-]+))?\/?$/i);
if (!m) return false;
const app = (m[1] || "").toLowerCase(), sub = m[2] || "";
if (!app) return true;
if (app === "servers") { openSettings("servers"); return true; }
if (!PAGES[app]) return false; // not one of ours: it is a file on this site
openPage(app);
if (sub) openSub(app, sub);
syncChrome();
return true;
}

async function go(t, raw) {
if (routeAlias(raw)) return;
if (t.kind !== "web") { const v = String(raw).trim(); if (v) newTab({ url: v }); return; } // typed a website while on one of our pages: open it in a new tab
const url = resolve(raw);
if (!url) return;
loaderStart(t);
try { await ready; } catch (e) { loaderStop(t.loader); toast(e.message); return; }
t.loader.target = Math.max(t.loader.target, 30);
if (!t.frame) {
t.frame = scramjet.createFrame();
t.view.insertBefore(t.frame.frame, t.loader.el);
t.view.classList.add("has-frame");
t.frame.frame.addEventListener("load", () => {
try { t.frame.frame.contentWindow.addEventListener("keydown", panicHandler, true); } catch {}
let blank = false; try { blank = t.frame.frame.contentWindow.location.href === "about:blank"; } catch {}
if (t.loading && !blank) { t.loading = false; t.loader.target = 100; }
syncTab(t);
});
}
t.url = url; t.title = hostOf(url); paintChip(t);
t.loading = true; t.loader.creep = true;
try { t.frame.go(url); } catch (e) { toast("couldn't open that page"); console.error(e); loaderStop(t.loader); }
if (t === active) syncChrome();
saveTabs();
}

function displayUrl(u) {
try {
const x = new URL(u);
if (x.origin === location.origin) return "Nex.Velo" + x.pathname.replace(/\.html$/, "").replace(/\/$/, "") + x.search;
} catch {}
return u;
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
function liveUrl(t) {
if (!t.frame) return "";
try { if (t.frame.url) return String(t.frame.url.href || t.frame.url); } catch {}
try { return scramjet.decodeUrl(t.frame.frame.contentWindow.location.href); } catch {}
return t.url;
}
function syncTab(t) {
if (!t.frame) return;
const before = t.url;
const u = liveUrl(t); if (u) t.url = u;
let title = ""; try { title = t.frame.frame.contentDocument.title; } catch {}
t.title = title || hostOf(t.url) || "New tab"; paintChip(t);
if (t === active) syncChrome();
if (before !== t.url) saveTabs();
}
function syncChrome() {
const browsing = !!(active && active.kind === "web" && active.frame);
const isPage = !!(active && PAGES[active.kind]);
document.body.classList.toggle("browsing", browsing);
document.body.classList.toggle("page-tab", isPage);
$("#address").readOnly = false;
if (isPage && document.activeElement !== $("#address")) $("#address").value = pageAddress(active.kind);
$("#bar-clock").hidden = !!(active && isHome(active)); // small clock appears once you leave the big-clock home page
if (browsing && document.activeElement !== $("#address")) $("#address").value = displayUrl(active.url);
document.title = browsing ? `${active.title} – Nex.Velo` : active && PAGES[active.kind] ? `${active.kind} – Nex.Velo` : "Nex.Velo";
}
setInterval(() => active && active.frame && syncTab(active), 900);

const hist = (fn) => { try { fn(active.frame.frame.contentWindow.history); } catch {} };
$("#back").addEventListener("click", () => hist((h) => h.back()));
$("#forward").addEventListener("click", () => hist((h) => h.forward()));
$("#reload").addEventListener("click", () => { try { loaderStart(active); active.loading = true; active.loader.creep = true; active.frame.frame.contentWindow.location.reload(); } catch { go(active, active.url); } });
$("#home").addEventListener("click", () => {
const t = active;
if (t.loader) loaderStop(t.loader);
t.frame.frame.remove(); t.frame = null; t.url = ""; t.title = "New tab"; t.loading = false;
t.view.classList.remove("has-frame"); t.input.value = ""; paintChip(t); syncChrome(); saveTabs();
});
$("#address").addEventListener("keydown", (e) => { if (e.key === "Enter") { go(active, e.target.value); e.target.blur(); } });
$("#address").addEventListener("focus", (e) => e.target.select());
$("#address").addEventListener("blur", () => syncChrome());
$("#new-tab").addEventListener("click", () => newTab());

/* ================= Bookmarks ================= */
const MARK_MAX = 5;
let marks = []; try { marks = (JSON.parse(LS.get("nexvelo.bookmarks", "[]")) || []).slice(0, MARK_MAX); } catch {}
const saveMarks = () => LS.set("nexvelo.bookmarks", JSON.stringify(marks));
const markHost = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
function markHTML(m, i) {
const letter = esc((m.name || markHost(m.url) || "?").trim()[0] || "?").toUpperCase();
const icon = `${API}/api/favicon?host=${encodeURIComponent(markHost(m.url))}`;
return `<div class="mark"><button class="mark-b" data-open="${i}" title="${esc(m.url)}"><img src="${esc(icon)}" alt="" data-l="${letter}" onerror="this.outerHTML='<i class=ph>'+this.dataset.l+'</i>'"><span class="mn">${esc(m.name)}</span></button><button class="mark-e" data-edit="${i}" aria-label="Edit bookmark">${ICON_EDIT}</button><button class="mark-x" data-del="${i}" aria-label="Remove bookmark">${ICON_X}</button></div>`;
}
function renderMarks() {
const html = marks.map(markHTML).join("") + (marks.length < MARK_MAX ? '<button class="mark add" data-add="1" aria-label="Add a bookmark" title="Add a bookmark">+</button>' : "");
$$(".marks").forEach((el) => { el.innerHTML = html; });
}
let editing = -1;
function markDialog(i) {
editing = i;
$("#mark-title").textContent = i >= 0 ? "edit bookmark" : "add a bookmark";
$("#mark-name").value = i >= 0 ? marks[i].name : ""; $("#mark-url").value = i >= 0 ? marks[i].url : "";
$("#mark-dlg").hidden = false; setTimeout(() => $(i >= 0 ? "#mark-name" : "#mark-url").focus(), 30);
}
document.addEventListener("click", (e) => {
const box = e.target.closest(".marks"); if (!box) return;
const open = e.target.closest("[data-open]"), del = e.target.closest("[data-del]"), ed = e.target.closest("[data-edit]");
if (e.target.closest("[data-add]")) markDialog(-1);
else if (ed) markDialog(+ed.dataset.edit);
else if (del) { marks.splice(+del.dataset.del, 1); saveMarks(); renderMarks(); }
else if (open) newTab({ url: marks[+open.dataset.open].url }); // opens through the proxy in a new tab
});
$("#mark-cancel").addEventListener("click", () => { $("#mark-dlg").hidden = true; });
$("#mark-form").addEventListener("submit", (e) => {
e.preventDefault();
let u = $("#mark-url").value.trim(); if (!u) return;
if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
let host; try { host = new URL(u).hostname; } catch { return toast("that link doesn't look right"); }
const name = ($("#mark-name").value.trim() || host.replace(/^www\./, "")).slice(0, 14);
if (editing >= 0) marks[editing] = { name, url: u };
else if (marks.length < MARK_MAX) marks.push({ name, url: u });
saveMarks(); renderMarks(); $("#mark-dlg").hidden = true;
});

/* ================= Settings UI ================= */
const status = $("#status");
const say = (msg, kind = "") => { status.textContent = msg; status.className = kind; };
const normalizeWisp = (v) => {
v = v.trim(); if (!v) return "";
if (/^https?:\/\//i.test(v)) v = v.replace(/^http/i, "ws");
if (!/^wss?:\/\//i.test(v)) v = "wss://" + v;
return v.endsWith("/") ? v : v + "/";
};
function testWisp(url, ms = 6000) {
return new Promise((resolve) => {
let done = false, ws;
const finish = (ok) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(ok); } };
try { ws = new WebSocket(url); } catch { return resolve(false); }
ws.onopen = () => finish(true); ws.onerror = () => finish(false); setTimeout(() => finish(false), ms);
});
}
function buildAppearance() {
$("#swatches").innerHTML = THEMES.map(([id, label, c]) => `<button class="sw${settings.theme === id ? " on" : ""}" data-theme="${id}"><i style="--c:${c}"></i>${label}</button>`).join("").replace(/class="sw( on)?" data-theme="custom"/, (m) => m.replace("class=\"sw", "class=\"sw custom"));
const walls = [["none", "none"], ["forest", "forest"], ["ocean", "ocean"], ["sky", "sky"], ["custom", "custom"]];
$("#walls").innerHTML = walls.map(([id, label]) => {
const src = id === "none" ? null : wallSrc(id);
const thumb = src && /^(https?:|data:image\/)/i.test(src) ? `style="background-image:url('${src.replace(/'/g, "%27")}')"` : "";
return `<button class="wt${settings.wall === id ? " on" : ""}" data-wall="${id}"><i ${thumb}>${thumb ? "" : id === "none" ? "–" : id === "custom" ? "+" : ""}</i>${label}</button>`;
}).join("");
$("#custom-opts").hidden = settings.theme !== "custom";
$("#wall-custom").hidden = settings.wall !== "custom";
$("#wall-clear").hidden = !wallData();
$("#wall-note").textContent = wallData() ? "using your uploaded image" : "";
$("#blur-opts").hidden = settings.wall === "none";
$("#blur-amt-fld").hidden = !settings.blur;
}
$("#swatches").addEventListener("click", (e) => {
const b = e.target.closest("[data-theme]"); if (!b) return;
settings.theme = b.dataset.theme; save(); applyTheme(); buildAppearance();
});
$("#c-font").innerHTML = Object.entries(FONTS).map(([k, f]) => `<option value="${k}">${f[0]}</option>`).join("");
function loadCustomUI() {
const c = settings.custom;
$("#c-bg").value = c.bg; $("#c-fg").value = c.fg; $("#c-accent").value = c.accent;
$("#c-clock").value = c.clock || c.fg; $("#c-bar").value = c.bar || "#2a2d33"; $("#c-font").value = c.font; $("#c-size").value = c.size;
}
const customInput = (id, key, mapper = (v) => v) => $(id).addEventListener("input", (e) => { settings.custom[key] = mapper(e.target.value); save(); applyTheme(); });
customInput("#c-bg", "bg"); customInput("#c-fg", "fg"); customInput("#c-accent", "accent");
customInput("#c-clock", "clock"); customInput("#c-bar", "bar"); customInput("#c-font", "font"); customInput("#c-size", "size", (v) => +v);
$("#c-reset").addEventListener("click", () => {
settings.custom = { bg: "#14161a", fg: "#f2f2f2", accent: "#8ab4ff", clock: "", bar: "", font: "jetbrains", size: 100 };
save(); applyTheme(); loadCustomUI();
});
$("#walls").addEventListener("click", (e) => {
const b = e.target.closest("[data-wall]"); if (!b) return;
settings.wall = b.dataset.wall; save(); applyWall(); buildAppearance();
});
$("#wall-url").addEventListener("change", (e) => { settings.wallUrl = e.target.value.trim(); LS.del("nexvelo.wallpaper"); save(); applyWall(); buildAppearance(); });
async function shrinkImage(file) {
const url = URL.createObjectURL(file);
const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
const k = Math.min(1, 1920 / Math.max(img.width, img.height));
const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
let q = .85, data = c.toDataURL("image/jpeg", q);
while (data.length > 2800000 && q > .4) { q -= .15; data = c.toDataURL("image/jpeg", q); }
return data;
}
$("#wall-upload").addEventListener("click", () => $("#wall-file").click());
$("#wall-file").addEventListener("change", async (e) => {
const f = e.target.files[0]; e.target.value = ""; if (!f) return;
if (!f.type.startsWith("image/")) return toast("that isn't an image");
try {
const data = await shrinkImage(f);
LS.set("nexvelo.wallpaper", data);
if (LS.get("nexvelo.wallpaper", "") !== data) throw new Error("storage full");
settings.wall = "custom"; save(); applyWall(); buildAppearance(); toast("wallpaper set");
} catch { LS.del("nexvelo.wallpaper"); toast("couldn't use that image. try a smaller one."); }
});
$("#wall-clear").addEventListener("click", () => { LS.del("nexvelo.wallpaper"); applyWall(); buildAppearance(); });
$("#blur").addEventListener("change", (e) => { settings.blur = e.target.checked; save(); applyWall(); buildAppearance(); });
$("#blur-amt").addEventListener("input", (e) => { settings.blurAmt = +e.target.value; save(); applyWall(); });
function loadSettingsUI() {
loadCustomUI();
$("#wisp-url").value = settings.wisp; $("#engine").value = settings.engine;
$("#adblock").checked = settings.adblock; $("#clock").checked = settings.clock; $("#h24").checked = settings.h24;
$("#blur").checked = settings.blur; $("#blur-amt").value = settings.blurAmt; $("#wall-url").value = settings.wallUrl;
$("#wisp-auto").checked = settings.wispAuto !== false; $("#launch-mode").value = settings.launch; $("#launch-redirect").checked = settings.launchRedirect; $("#panic-on").checked = settings.panicOn; $("#panic-key").textContent = settings.panicKey; $("#panic-site").value = settings.panicSite; $("#panic-url").value = settings.panicUrl; $("#panic-url-fld").hidden = settings.panicSite !== "custom"; $("#panic-mode").value = settings.panicMode; $("#music-on").checked = settings.music; $("#games-on").checked = settings.games; $("#ai-on").checked = settings.ai; $("#name").value = settings.name;
buildAppearance(); say("");
NV.refreshMusicChips && NV.refreshMusicChips();
}
function openSettings(sec) {
openPage("settings");
if (sec) showSec(sec);
}
function showSec(id) {
$$(".nb").forEach((b) => b.classList.toggle("on", b.dataset.sec === id));
$$(".sec").forEach((s) => s.classList.toggle("on", s.id === "sec-" + id));
$(".spane").scrollTop = 0;
if (id === "diagnostics") { // the Diagnostics tool is loaded the first time this section is opened
const f = $("#diag-frame");
if (f && !f.getAttribute("src")) apiReady.then(() => { f.src = "/diagnostics.html?embed=1" + (API ? "&api=" + encodeURIComponent(API) : "") + "&v=" + VERSION; });
}
syncChrome();
}
$(".snav").addEventListener("click", (e) => { const b = e.target.closest(".nb"); if (b) showSec(b.dataset.sec); });
$("#open-settings").addEventListener("click", () => openSettings());
$("#wisp-test").addEventListener("click", async () => {
const url = normalizeWisp($("#wisp-url").value);
if (!url) return say("enter a wisp server address.", "bad");
say("testing connection…");
const ok = await testWisp(url);
say(ok ? "server is reachable." : "couldn't connect. check the address and that it ends in /wisp/.", ok ? "ok" : "bad");
});
$("#wisp-default").addEventListener("click", () => { $("#wisp-url").value = defaultWisp; say(""); });
$("#wisp-save").addEventListener("click", async () => {
const url = normalizeWisp($("#wisp-url").value);
if (!url) return say("enter a wisp server address.", "bad");
settings.wisp = url; activeWisp = url; save(); $("#wisp-url").value = url;
try { await applyTransport(); say("server saved. new requests will use it.", "ok"); }
catch { say("couldn't switch servers. reload the page and try again.", "bad"); }
});
$("#engine").addEventListener("change", (e) => { settings.engine = e.target.value; save(); });
$("#adblock").addEventListener("change", (e) => { settings.adblock = e.target.checked; save(); pushAdblock(); });
$("#clock").addEventListener("change", (e) => { settings.clock = e.target.checked; save(); tickClock(); });
$("#h24").addEventListener("change", (e) => { settings.h24 = e.target.checked; save(); tickClock(); });
$("#music-on").addEventListener("change", (e) => { settings.music = e.target.checked; save(); NV.applyMusicToggle && NV.applyMusicToggle(); });
$("#wisp-auto").addEventListener("change", (e) => { settings.wispAuto = e.target.checked; save(); });
$("#launch-mode").addEventListener("change", (e) => { settings.launch = e.target.value; save(); });
$("#launch-redirect").addEventListener("change", (e) => { settings.launchRedirect = e.target.checked; save(); });
$("#panic-on").addEventListener("change", (e) => { settings.panicOn = e.target.checked; save(); });
$("#panic-site").addEventListener("change", (e) => { settings.panicSite = e.target.value; $("#panic-url-fld").hidden = e.target.value !== "custom"; save(); });
$("#panic-mode").addEventListener("change", (e) => { settings.panicMode = e.target.value; save(); });
$("#panic-url").addEventListener("change", (e) => { let u = e.target.value.trim(); if (u && !/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u; settings.panicUrl = u; e.target.value = u; save(); });
// Pick the escape key: click the button, then press the key you want. Escape itself can be chosen now. Click the button again to cancel.
$("#panic-key").addEventListener("click", (e) => {
capturing = !capturing;
e.target.textContent = capturing ? "press a key…" : settings.panicKey;
});
addEventListener("keydown", (e) => {
if (!capturing) return;
if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"].includes(e.key)) return; // wait for the real key
e.preventDefault(); e.stopPropagation(); capturing = false;
settings.panicKey = e.key.length === 1 ? e.key.toLowerCase() : e.key; save();
$("#panic-key").textContent = settings.panicKey;
toast("escape key set to " + settings.panicKey);
}, true);
$("#ai-on").addEventListener("change", (e) => { settings.ai = e.target.checked; save(); });
$("#games-on").addEventListener("change", (e) => { settings.games = e.target.checked; save(); });
$("#name").addEventListener("input", (e) => { settings.name = e.target.value.trim(); save(); tickClock(); });

/* account: backup / restore / reset */
const DATA_KEYS = ["nexvelo.settings", "nexvelo.playlists", "nexvelo.recent", "nexvelo.music", "nexvelo.volume", "nexvelo.tabs", "nexvelo.ai", "nexvelo.servers"];
$("#exp").addEventListener("click", () => {
const out = {}; DATA_KEYS.forEach((k) => { out[k] = LS.get(k, null); });
const a = document.createElement("a");
a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
a.download = "nex-velo-data.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$("#imp").addEventListener("click", () => $("#imp-file").click());
$("#imp-file").addEventListener("change", async (e) => {
const f = e.target.files[0]; if (!f) return;
try {
const data = JSON.parse(await f.text());
DATA_KEYS.forEach((k) => { if (typeof data[k] === "string") LS.set(k, data[k]); });
toast("imported. reloading…"); setTimeout(() => location.reload(), 700);
} catch { toast("that file couldn't be read."); }
});
$("#reset").addEventListener("click", () => {
if (!confirm("reset all settings, playlists and recently played on this browser?")) return;
DATA_KEYS.forEach(LS.del); location.reload();
});

/* ================= Apps (the nine-dot button in the top bar) ================= */
const APP_SVG = {
games: '<svg viewBox="0 0 24 24"><path d="M6 9h12a3 3 0 0 1 3 3.2l-.6 4A2.4 2.4 0 0 1 16 17.3L15 15H9l-1 2.3a2.4 2.4 0 0 1-4.4-1.1l-.6-4A3 3 0 0 1 6 9z"/><path d="M8 11v3M6.5 12.5h3M16 12h.01M18 13.5h.01"/></svg>',
music: '<svg viewBox="0 0 24 24"><path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>',
ai: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/></svg>',
servers: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
diagnostics: '<svg viewBox="0 0 24 24"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>',
settings: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
};
// [id, name, shown?, what it does]
const APPS = [
["games", "Games", () => settings.games, () => openPage("games")],
["music", "Music", () => settings.music, () => openPage("music")],
["ai", "AI", () => settings.ai, () => openPage("ai")],
["servers", "Servers", () => true, () => openSettings("servers")],
["diagnostics", "Diagnostics", () => true, () => openSettings("diagnostics")],
["settings", "Settings", () => true, () => openSettings()],
];
let appsOpen = false, appsTimer = 0;
function openApps() {
const menu = $("#apps-menu"), btn = $("#apps-btn");
clearTimeout(appsTimer);
menu.innerHTML = APPS.filter((a) => a[2]()).map((a) => `<button class="app-tile" role="menuitem" data-app="${a[0]}">${APP_SVG[a[0]]}<span>${esc(a[1])}</span></button>`).join("");
const r = btn.getBoundingClientRect();
menu.style.top = r.bottom + 8 + "px"; menu.style.right = Math.max(8, innerWidth - r.right - 4) + "px"; menu.style.left = "auto";
menu.hidden = false; menu.className = "in"; appsOpen = true;
btn.setAttribute("aria-expanded", "true");
}
function closeApps() {
if (!appsOpen) return;
const menu = $("#apps-menu");
appsOpen = false; $("#apps-btn").setAttribute("aria-expanded", "false");
menu.className = "out";
appsTimer = setTimeout(() => { if (!appsOpen) { menu.hidden = true; menu.className = ""; } }, reduceMotion() ? 0 : 150);
}
$("#apps-btn").addEventListener("click", () => (appsOpen ? closeApps() : openApps()));
$("#apps-menu").addEventListener("click", (e) => {
const b = e.target.closest("[data-app]"); if (!b) return;
const a = APPS.find((x) => x[0] === b.dataset.app); closeApps(); a && a[3]();
});
document.addEventListener("pointerdown", (e) => { if (appsOpen && !e.target.closest("#apps-menu, #apps-btn")) closeApps(); });
addEventListener("keydown", (e) => { if (e.key === "Escape" && appsOpen) closeApps(); });
addEventListener("blur", () => closeApps()); // clicking into a page frame

/* ================= Tour ================= */
const STEPS = [
["#tabs", "these are your tabs. every tab is its own proxied page."],
["#new-tab", "open a new tab here."],
["#apps-btn", "the nine dots open all your apps: games, music, ai, servers and diagnostics."],
["#open-settings", "themes, wallpapers, your wisp server and more."],
[".view.active .omni", "type a search or a web address and press enter."],
];
function startTour() {
const steps = STEPS.filter(([s]) => { const el = $(s); return el && el.offsetParent !== null; });
if (!steps.length) return;
let i = 0;
const ov = $("#tour"), hl = $("#tour-hl"), card = $("#tour-card"), next = $("#tour-next");
ov.hidden = false;
const show = () => {
const [sel, text] = steps[i], r = $(sel).getBoundingClientRect(), pad = 6;
Object.assign(hl.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px" });
$("#tour-text").textContent = text;
next.textContent = i === steps.length - 1 ? "done" : "next";
const cw = Math.min(280, innerWidth * .86);
const below = r.bottom + 14 + 130 < innerHeight;
card.style.top = (below ? r.bottom + 14 : Math.max(8, r.top - 14 - 130)) + "px";
card.style.left = Math.max(8, Math.min(innerWidth - cw - 8, r.left + r.width / 2 - cw / 2)) + "px";
};
const end = () => { ov.hidden = true; next.onclick = null; $("#tour-skip").onclick = null; };
next.onclick = () => { if (++i >= steps.length) end(); else show(); };
$("#tour-skip").onclick = end;
show();
}
$("#tour-btn").addEventListener("click", startTour);

/* ================= Boot ================= */
const NV = window.NV = {
settings, save, esc, toast, spring, openSettings, openPage, openUrl: (u) => newTab({ url: u }), LS, defaultWisp, VERSION, api: (p) => API + p, testWisp, normalizeWisp,
proxyFrame: async (url) => { await ready; const f = scramjet.createFrame(); f.go(url); return f.frame; },
setWisp: async (url) => { settings.wisp = url; activeWisp = url; save(); $("#wisp-url").value = url; await applyTransport(); },
activeWisp: () => activeWisp, loaded: {}, rawFetch: _fetch, apiBase: () => API || location.origin,
syncChrome: () => syncChrome(), routeTo: (a) => routeAlias(a), panic: panicHandler,
};
applyTheme(); applyWall();
$("#ver").textContent = "v" + VERSION;
$("#logo").addEventListener("click", () => newTab());
restoring = true;
let saved = null; try { saved = JSON.parse(LS.get("nexvelo.tabs", "null")); } catch {}
if (saved && saved.t && saved.t.length) {
saved.t.forEach((x) => { if (x.k === "web" || PAGES[x.k]) if (!(PAGES[x.k] && tabs.some((t) => t.kind === x.k))) newTab({ kind: x.k, url: x.u, lazy: true }); });
}
restoring = false;
if (!tabs.length) newTab(); else select(tabs[Math.min(Math.max(saved.a, 0), tabs.length - 1)] || tabs[0]);

/* ================= Launch choice: about:blank (recommended) or this page ================= */
function openBlank() {
const w = window.open("about:blank", "_blank");
if (!w) { toast("allow pop-ups for this site, then try again"); return false; }
const d = w.document;
d.title = "Nex.Velo";
d.head.innerHTML = "<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%;display:block}</style>";
const f = d.createElement("iframe");
f.src = location.href.split("#")[0];
f.allow = "fullscreen; autoplay; microphone; camera; display-capture; clipboard-read; clipboard-write";
d.body.appendChild(f);
return true;
}
apiReady.then(renderMarks);
const checkModules = () => {
const need = { music: "music.js", ai: "ai.js", games: "games.js", servers: "servers.js" };
const miss = Object.entries(need).filter(([k]) => !NV.loaded[k]).map(([, f]) => f);
if (miss.length) showBanner("these parts couldn't start: " + miss.join(", ") + ". upload the newest files to the public folder and clear the CDN cache.");
};
if (window.__nvScriptsDone) setTimeout(checkModules, 300); else addEventListener("nv-scripts", () => setTimeout(checkModules, 300), { once: true });

/* ================= Automatic updates ================= */
// version.json on the host holds the newest version number. When it differs from this page, offer the update and apply it.
let updating = false, laterUntil = 0;
const typing = () => { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && !!a.value && a.type !== "range" && a.type !== "checkbox"; };
function applyUpdate(v) { location.replace(location.pathname + "?nv=" + encodeURIComponent(v) + location.hash); }
function offerUpdate(v) {
const bar = $("#update"); if (!bar || updating || Date.now() < laterUntil) return;
updating = true; let n = 20;
const paint = () => { bar.innerHTML = `<span>Nex.Velo v${esc(v)} is ready. updating in ${n}s…</span><button class="btn" data-now type="button">update now</button><button class="btn" data-later type="button">later</button>`; };
paint(); bar.hidden = false;
const tick = setInterval(() => { if (typing()) { n = 20; paint(); return; } if (--n <= 0) { clearInterval(tick); applyUpdate(v); } else paint(); }, 1000);
bar.onclick = (e) => {
if (e.target.closest("[data-now]")) { clearInterval(tick); applyUpdate(v); }
if (e.target.closest("[data-later]")) { clearInterval(tick); bar.hidden = true; updating = false; laterUntil = Date.now() + 30 * 60 * 1000; }
};
}
async function checkUpdate() {
try {
const r = await _fetch("/version.json?t=" + Date.now(), { cache: "no-store" });
if (r.ok) { const v = (await r.json()).version; if (v && v !== VERSION) offerUpdate(v); }
} catch {}
try { const reg = await navigator.serviceWorker?.getRegistration(); reg && reg.update(); } catch {}
}
setTimeout(checkUpdate, 20000);
setInterval(checkUpdate, 5 * 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdate(); });

(function launchChoice() {
if (window.top !== window.self || settings.launch === "here") return; // already wrapped, or the user chose "here"
const box = $("#launch");
$("#l-here").hidden = settings.launch === "blank";
$("#l-remember-row").hidden = settings.launch === "blank";
box.hidden = false;
$("#l-blank").addEventListener("click", () => {
if (!openBlank()) return;
if ($("#l-remember").checked) { settings.launch = "blank"; save(); }
box.hidden = true;
if (settings.launchRedirect) location.replace(panicDest()); // this tab jumps to the escape page
});
$("#l-here").addEventListener("click", () => {
if ($("#l-remember").checked) { settings.launch = "here"; save(); }
box.hidden = true;
});
})();
})();
