/* Nex.Velo bundle: core + music + ai + games + servers */
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

  const VERSION = "0.99.5";
  // On the Nex.Velo server itself the API is same-origin. On any other host (e.g. Vercel) it lives on the Railway server.
  const API = /(^|\.)railway\.app$/i.test(location.hostname) || /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "" : "https://nex-velo.up.railway.app";
  { const _fetch = window.fetch.bind(window); window.fetch = (u, o) => (typeof u === "string" && u.startsWith("/api/") ? _fetch(API + u, o) : _fetch(u, o)); }

  /* ================= Settings ================= */
  const defaultWisp = "wss://nex-velo.up.railway.app/wisp/";   // the Nex.Velo server, always available as the default
  const settings = {
    wisp: defaultWisp, engine: "https://duckduckgo.com/?q=%s", adblock: true,
    theme: "black", wall: "none", wallUrl: "", blur: true, blurAmt: 14,
    clock: true, h24: true, music: true, games: true, ai: true, name: "",
    launch: "ask", launchRedirect: true,
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
  const applyTransport = () => connection.setTransport("/libcurl/index.mjs", [{ wisp: settings.wisp, websocket: settings.wisp }]);
  async function pushAdblock() {
    const reg = await navigator.serviceWorker.ready;
    (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: "adblock", enabled: settings.adblock });
  }
  const ready = (async () => {
    if (!("serviceWorker" in navigator)) throw new Error("Service workers aren't supported in this browser.");
    await scramjet.init();   // create Scramjet's database before the service worker starts
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
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

  /* ================= Escape key ================= */
  function panicHandler(e) {
    if (!settings.panicOn || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k !== settings.panicKey) return;
    const t = e.target, typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (typing && settings.panicKey.length === 1) return;   // single letters would fire while typing
    e.preventDefault(); e.stopPropagation();
    const dest = panicDest();
    const top = (() => { try { return window.top.location.href, window.top; } catch { return window; } })();
    if (settings.panicMode === "new") { window.open(dest, "_blank", "noopener"); top.location.replace("about:blank"); }
    else top.location.replace(dest);
  }
  addEventListener("keydown", panicHandler, true);

  /* ================= URL handling ================= */
  const ALIAS = /^(?:https?:\/\/)?nex\.?velo(?:\/(games|music|ai|settings|servers))?\/?$/i;
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
    L.timer = setTimeout(() => showQuote(L), words(text) * 2000);   // 1 word = 2 seconds
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
    clearTimeout(L.guard); L.guard = setTimeout(() => loaderStop(L), 60000);   // never get stuck
  }
  function loaderStop(L) {
    if (!L || !L.on) return;
    L.on = false; cancelAnimationFrame(L.raf); clearTimeout(L.timer); clearTimeout(L.guard);
    L.el.classList.add("out"); setTimeout(() => { if (!L.on) L.el.hidden = true; }, 320);
  }

  /* ================= Tabs ================= */
  // kinds: "web" (home page or a proxied site), "settings", "games"
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
    setTimeout(() => {   // let the close animation play, then clean up
      const node = PAGES[t.kind];
      if (node && node.parentNode === t.view) $("#pages").appendChild(node);
      t.chip.remove(); t.view.remove();
    }, reduceMotion() ? 0 : 190);
    if (!tabs.length) return newTab();
    if (wasActive) select(tabs[Math.min(i, tabs.length - 1)]); else saveTabs();
  }
  function openPage(kind) {
    const ex = tabs.find((t) => t.kind === kind);
    if (ex) { select(ex); if (kind === "settings") loadSettingsUI(); } else newTab({ kind });
  }

  async function go(t, raw) {
    if (t.kind !== "web") return;
    const al = String(raw).trim().match(ALIAS);
    if (al) { if (al[1] === "servers") openSettings("servers"); else if (al[1]) openPage(al[1]); return; }
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
    $("#address").readOnly = isPage;
    if (isPage && document.activeElement !== $("#address")) $("#address").value = "Nex.Velo/" + active.kind;
    $("#bar-clock").hidden = !!(active && isHome(active));   // small clock appears once you leave the big-clock home page
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
  $("#address").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.target.readOnly) { go(active, e.target.value); e.target.blur(); } });
  $("#address").addEventListener("focus", (e) => e.target.select());
  $("#new-tab").addEventListener("click", () => newTab());

  /* ================= Bookmarks ================= */
  const MARK_MAX = 5;
  let marks = []; try { marks = (JSON.parse(LS.get("nexvelo.bookmarks", "[]")) || []).slice(0, MARK_MAX); } catch {}
  const saveMarks = () => LS.set("nexvelo.bookmarks", JSON.stringify(marks));
  const markHost = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
  function markHTML(m, i) {
    const letter = esc((m.name || markHost(m.url) || "?").trim()[0] || "?").toUpperCase();
    const icon = `${API}/api/favicon?host=${encodeURIComponent(markHost(m.url))}`;
    return `<div class="mark"><button class="mark-b" data-open="${i}" title="${esc(m.url)}"><img src="${esc(icon)}" alt="" data-l="${letter}" onerror="this.outerHTML='<i class=ph>'+this.dataset.l+'</i>'"><span class="mn">${esc(m.name)}</span></button><button class="mark-e" data-edit="${i}" aria-label="Edit bookmark">✎</button><button class="mark-x" data-del="${i}" aria-label="Remove bookmark">×</button></div>`;
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
    else if (open) newTab({ url: marks[+open.dataset.open].url });   // opens through the proxy in a new tab
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
  const testWisp = (url) => new Promise((resolve) => {
    let done = false, ws;
    const finish = (ok) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(ok); } };
    try { ws = new WebSocket(url); } catch { return resolve(false); }
    ws.onopen = () => finish(true); ws.onerror = () => finish(false); setTimeout(() => finish(false), 6000);
  });

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
    $("#launch-mode").value = settings.launch; $("#launch-redirect").checked = settings.launchRedirect; $("#panic-on").checked = settings.panicOn; $("#panic-key").textContent = settings.panicKey; $("#panic-site").value = settings.panicSite; $("#panic-url").value = settings.panicUrl; $("#panic-url-fld").hidden = settings.panicSite !== "custom"; $("#panic-mode").value = settings.panicMode; $("#music-on").checked = settings.music; $("#games-on").checked = settings.games; $("#ai-on").checked = settings.ai; $("#name").value = settings.name;
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
    settings.wisp = url; save(); $("#wisp-url").value = url;
    try { await applyTransport(); say("server saved. new requests will use it.", "ok"); }
    catch { say("couldn't switch servers. reload the page and try again.", "bad"); }
  });
  $("#engine").addEventListener("change", (e) => { settings.engine = e.target.value; save(); });
  $("#adblock").addEventListener("change", (e) => { settings.adblock = e.target.checked; save(); pushAdblock(); });
  $("#clock").addEventListener("change", (e) => { settings.clock = e.target.checked; save(); tickClock(); });
  $("#h24").addEventListener("change", (e) => { settings.h24 = e.target.checked; save(); tickClock(); });
  $("#music-on").addEventListener("change", (e) => { settings.music = e.target.checked; save(); NV.applyMusicToggle && NV.applyMusicToggle(); });
  $("#launch-mode").addEventListener("change", (e) => { settings.launch = e.target.value; save(); });
  $("#launch-redirect").addEventListener("change", (e) => { settings.launchRedirect = e.target.checked; save(); });
  $("#panic-on").addEventListener("change", (e) => { settings.panicOn = e.target.checked; save(); });
  $("#panic-site").addEventListener("change", (e) => { settings.panicSite = e.target.value; $("#panic-url-fld").hidden = e.target.value !== "custom"; save(); });
  $("#panic-mode").addEventListener("change", (e) => { settings.panicMode = e.target.value; save(); });
  $("#panic-url").addEventListener("change", (e) => { let u = e.target.value.trim(); if (u && !/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u; settings.panicUrl = u; e.target.value = u; save(); });
  let capturing = false;
  $("#panic-key").addEventListener("click", (e) => { capturing = true; e.target.textContent = "press a key…"; });
  addEventListener("keydown", (e) => {
    if (!capturing) return;
    e.preventDefault(); e.stopPropagation(); capturing = false;
    if (e.key !== "Escape") { settings.panicKey = e.key.length === 1 ? e.key.toLowerCase() : e.key; save(); }
    $("#panic-key").textContent = settings.panicKey;
  }, true);
  $("#ai-on").addEventListener("change", (e) => { settings.ai = e.target.checked; save(); $("#open-ai").hidden = !settings.ai; });
  $("#games-on").addEventListener("change", (e) => { settings.games = e.target.checked; save(); $("#open-games").hidden = !settings.games; });
  $("#name").addEventListener("input", (e) => { settings.name = e.target.value.trim(); save(); tickClock(); });

  /* account: backup / restore / reset */
  const DATA_KEYS = ["nexvelo.settings", "nexvelo.playlists", "nexvelo.recent", "nexvelo.music", "nexvelo.tabs", "nexvelo.ai", "nexvelo.servers"];
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

  /* ================= Tour ================= */
  const STEPS = [
    ["#tabs", "these are your tabs. every tab is its own proxied page."],
    ["#new-tab", "open a new tab here."],
    ["#open-ai", "an ai assistant in its own tab. it can see your screen, hear you and read files."],
    ["#open-games", "a library of browser games. pick one and it opens in its own tab."],
    ["#open-music", "search youtube music and soundcloud at once. playlists and recents live here too."],
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
    setWisp: async (url) => { settings.wisp = url; save(); $("#wisp-url").value = url; await applyTransport(); },
  };
  applyTheme(); applyWall();
  $("#ver").textContent = "v" + VERSION;
  $("#open-games").hidden = !settings.games;
  $("#open-ai").hidden = !settings.ai;
  $("#open-ai").addEventListener("click", () => openPage("ai"));
  $("#open-games").addEventListener("click", () => openPage("games"));
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
  (function launchChoice() {
    if (window.top !== window.self || settings.launch === "here") return;   // already wrapped, or the user chose "here"
    const box = $("#launch");
    $("#l-here").hidden = settings.launch === "blank";
    $("#l-remember-row").hidden = settings.launch === "blank";
    box.hidden = false;
    $("#l-blank").addEventListener("click", () => {
      if (!openBlank()) return;
      if ($("#l-remember").checked) { settings.launch = "blank"; save(); }
      box.hidden = true;
      if (settings.launchRedirect) location.replace(panicDest());   // this tab jumps to the escape page
    });
    $("#l-here").addEventListener("click", () => {
      if ($("#l-remember").checked) { settings.launch = "here"; save(); }
      box.hidden = true;
    });
  })();
})();

/* Music: search YouTube Music + SoundCloud, play through the Nex.Velo server, lyrics, playlists, recently played. */
(() => {
  "use strict";
  const { settings, esc, toast, LS } = window.NV;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const load = (k, d) => { try { return JSON.parse(LS.get(k, "")) ?? d; } catch { return d; } };
  const store = (k, v) => LS.set(k, JSON.stringify(v));
  const key = (t) => t.source + ":" + t.id;
  const fmt = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "");
  const srcName = (s) => (s === "youtube" ? "youtube music" : "soundcloud");
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5v14M17 5v14"/></svg>',
  };

  let playlists = load("nexvelo.playlists", []);   // [{id, name, tracks: []}]
  let recent = load("nexvelo.recent", []);         // [track]
  let results = [], lastStatus = null, openPl = null, musicTab = false;

  /* ---------- saved player state ---------- */
  const saved = load("nexvelo.music", {});          // {collapsed, cur, queue, qi, pos}
  let collapsed = !!saved.collapsed;
  let cur = saved.cur || null, queue = saved.queue || [], qi = saved.qi ?? -1, playing = false, pos = saved.pos || 0, dur = saved.cur?.dur || 0;
  let resumeAt = pos, lastSave = 0;
  const persist = (force) => {
    const now = Date.now(); if (!force && now - lastSave < 4000) return; lastSave = now;
    store("nexvelo.music", { collapsed, cur, queue: queue.slice(0, 100), qi, pos });
  };

  /* ---------- audio (streamed through this server so the browser never talks to YouTube/SoundCloud) ---------- */
  const audio = new Audio();
  audio.preload = "none";
  const srcFor = (t) => window.NV.api(`/api/music/stream?source=${t.source}&id=${encodeURIComponent(t.id)}`);
  audio.addEventListener("play", () => setPlaying(true));
  audio.addEventListener("pause", () => { setPlaying(false); persist(true); });
  audio.addEventListener("ended", () => next());
  audio.addEventListener("loadedmetadata", () => {
    if (isFinite(audio.duration)) dur = audio.duration;
    if (resumeAt > 1 && resumeAt < dur) audio.currentTime = resumeAt;
    resumeAt = 0;
  });
  audio.addEventListener("timeupdate", () => { pos = audio.currentTime || 0; if (isFinite(audio.duration)) dur = audio.duration; paintProgress(); syncLyrics(); persist(); posState(); });
  audio.addEventListener("error", () => onFail());

  let failedOnce = new Set();
  async function onFail() {
    if (!cur) return;
    const k = key(cur);
    if (failedOnce.has(k)) { setPlaying(false); toast("couldn't play that track. try another."); return; }
    failedOnce.add(k);
    // YouTube can refuse server downloads. Try the same song on SoundCloud instead.
    if (cur.source === "youtube") {
      try {
        const r = await fetch("/api/music/alt?q=" + encodeURIComponent(`${cur.artist} ${cur.title}`));
        const d = await r.json();
        if (d.track) {
          const alt = { ...d.track, thumb: d.track.thumb || cur.thumb };
          queue[qi] = alt; cur = alt; paintMini(); loadLyrics(alt); toast("youtube blocked that one, playing the soundcloud version");
          audio.src = srcFor(alt); audio.play().catch(() => {}); return;
        }
      } catch {}
    }
    setPlaying(false); toast("couldn't play that track. try another.");
  }

  /* ---------- playback control ---------- */
  function playAt(list, i) {
    const t = list[i]; if (!t) return;
    queue = list; qi = i; cur = t; pos = 0; dur = t.dur || 0; resumeAt = 0;
    audio.src = srcFor(t);
    audio.play().catch(() => onFail());
    addRecent(t); paintMini(); markNow(); persist(true); loadLyrics(t);
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: srcName(t.source), artwork: t.thumb ? [{ src: t.thumb, sizes: "300x300" }, { src: t.thumb, sizes: "512x512" }] : [] });
  }
  const setPlaying = (v) => {
    playing = v; const i = v ? ICON.pause : ICON.play;
    $("#m-play").innerHTML = i; $("#np-play").innerHTML = i;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = v ? "playing" : "paused";
    paintPip();
  };
  function toggle() {
    if (!cur) return;
    if (!audio.src) { audio.src = srcFor(cur); resumeAt = pos; }   // restored from last visit
    if (lyr.key !== key(cur)) loadLyrics(cur);
    audio.paused ? audio.play().catch(() => onFail()) : audio.pause();
  }
  function next() { if (qi < queue.length - 1) playAt(queue, qi + 1); else { setPlaying(false); } }
  function prev() { if (pos > 4) seek(0); else if (qi > 0) playAt(queue, qi - 1); else seek(0); }
  function seek(frac) { if (!cur || !dur) return; if (!audio.src) { audio.src = srcFor(cur); } pos = frac * dur; audio.currentTime = pos; paintProgress(); }
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession, set = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
    set("play", () => { if (audio.paused) toggle(); }); set("pause", () => { if (!audio.paused) toggle(); });
    set("nexttrack", next); set("previoustrack", prev);
    set("seekto", (d) => { if (d.seekTime != null) { audio.currentTime = d.seekTime; } });
    set("seekbackward", (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
    set("seekforward", (d) => { audio.currentTime = Math.min(dur || 1e9, audio.currentTime + (d.seekOffset || 10)); });
  }
  let lastPos = 0;
  function posState() {
    if (!("mediaSession" in navigator) || !dur || !isFinite(dur) || Date.now() - lastPos < 1000) return;
    lastPos = Date.now();
    try { navigator.mediaSession.setPositionState({ duration: dur, playbackRate: 1, position: Math.min(pos, dur) }); } catch {}
  }

  /* ---------- mini player (can be folded away with the arrow) ---------- */
  function paintMini() {
    const show = !!cur && settings.music && !musicTab;
    $("#mini").hidden = !show || collapsed;
    $("#m-open").hidden = !show || !collapsed;
    if (!cur) return;
    $("#np-cov").src = cur.thumb || ""; $("#np-cov").style.visibility = cur.thumb ? "visible" : "hidden";
    $("#np-t").textContent = cur.title; $("#np-a").textContent = `${cur.artist} · ${srcName(cur.source)}`;
    paintPip();
    const c = $("#mini-cov"); c.src = cur.thumb || ""; c.style.visibility = cur.thumb ? "visible" : "hidden";
    $("#mini-t").textContent = cur.title; $("#mini-a").textContent = `${cur.artist} · ${srcName(cur.source)}`;
    paintProgress();
  }
  function paintProgress() { $("#prog i").style.width = dur ? Math.min(100, (pos / dur) * 100) + "%" : "0"; }
  $("#m-toggle").addEventListener("click", () => { collapsed = true; paintMini(); persist(true); });
  $("#m-open").addEventListener("click", () => { collapsed = false; paintMini(); persist(true); });
  $("#m-play").addEventListener("click", toggle);
  $("#m-next").addEventListener("click", next);
  $("#m-prev").addEventListener("click", prev);
  $("#mini-info").addEventListener("click", () => openMusic());
  $("#prog").addEventListener("pointerdown", (e) => { const r = e.currentTarget.getBoundingClientRect(); seek((e.clientX - r.left) / r.width); });
  $("#m-play").innerHTML = ICON.play; $("#np-play").innerHTML = ICON.play;
  $("#np-play").addEventListener("click", toggle); $("#np-next").addEventListener("click", next); $("#np-prev").addEventListener("click", prev);
  $("#np-pop").addEventListener("click", () => popOut()); $("#m-pop").addEventListener("click", () => popOut());

  /* ---------- lyrics (LRCLIB via the server) ---------- */
  let lyr = { key: "", synced: [], idx: -1 };
  const lyrBox = () => $("#lyr");
  const lyrMsg = (m) => { lyrBox().innerHTML = `<div class="msg">${esc(m)}</div>`; };
  async function loadLyrics(t) {
    const k = key(t); lyr = { key: k, synced: [], idx: -1 };
    lyrMsg("looking for lyrics…");
    try {
      const r = await fetch(`/api/lyrics?title=${encodeURIComponent(t.title)}&artist=${encodeURIComponent(t.artist)}&dur=${Math.round(t.dur || 0)}`);
      const d = await r.json(); if (lyr.key !== k) return;
      if (!d.found) return lyrMsg("no lyrics found for this song.");
      if (d.instrumental) return lyrMsg("instrumental ♪");
      if (d.synced?.length) {
        lyr.synced = d.synced;
        lyrBox().innerHTML = d.synced.map((l, i) => `<p data-i="${i}">${esc(l.text) || "♪"}</p>`).join("");
        syncLyrics(true);
      } else if (d.plain) lyrBox().innerHTML = `<p class="plain">${esc(d.plain)}</p>`;
      else lyrMsg("no lyrics found for this song.");
    } catch { if (lyr.key === k) lyrMsg("couldn't load lyrics."); }
  }
  function syncLyrics(force) {
    const L = lyr.synced; if (!L.length) return;
    let lo = 0, hi = L.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= pos + 0.2) { idx = m; lo = m + 1; } else hi = m - 1; }
    if (idx === lyr.idx && !force) return;
    const ps = lyrBox().children;
    if (ps[lyr.idx]) ps[lyr.idx].classList.remove("on");
    lyr.idx = idx;
    const el = ps[idx]; if (!el) return;
    el.classList.add("on");
    if (musicTab) { const box = lyrBox(); box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: "smooth" }); }
  }
  lyrBox().addEventListener("click", (e) => {
    const p = e.target.closest("p[data-i]"); if (!p || !cur) return;
    if (!audio.src) { audio.src = srcFor(cur); }
    audio.currentTime = lyr.synced[+p.dataset.i].t; if (audio.paused) audio.play().catch(() => {});
  });

  /* ---------- pop-out controller (small floating window, no lyrics) ---------- */
  let pip = null;
  function paintPip() {
    if (!pip || !cur) return;
    const d = pip.document, $$ = (i) => d.getElementById(i);
    $$("c").src = cur.thumb || ""; $$("t").textContent = cur.title; $$("a").textContent = `${cur.artist} · ${srcName(cur.source)}`;
    $$("pl").textContent = playing ? "⏸" : "▶"; $$("f").style.width = dur ? Math.min(100, (pos / dur) * 100) + "%" : "0";
  }
  setInterval(() => pip && paintPip(), 400);
  async function popOut() {
    if (pip) { pip.close(); pip = null; return; }
    if (!cur) return toast("play a song first");
    if (!("documentPictureInPicture" in window)) return toast("this browser can't pop out the controller. use the media controls in its toolbar instead.");
    try {
      pip = await documentPictureInPicture.requestWindow({ width: 360, height: 150 });
      const d = pip.document;
      d.body.style.cssText = "margin:0;background:#000;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;gap:12px;padding:12px;overflow:hidden";
      d.body.innerHTML = '<img id="c" style="width:76px;height:76px;border-radius:12px;object-fit:cover;background:#111;flex:none"><div style="flex:1;min-width:0"><div id="t" style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div><div id="a" style="font-size:12px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div><div style="display:flex;gap:6px;margin-top:8px"><button id="p">⏮</button><button id="pl">▶</button><button id="n">⏭</button></div><div id="bar" style="height:6px;background:#333;border-radius:3px;margin-top:10px;cursor:pointer"><i id="f" style="display:block;height:100%;width:0;background:#fff;border-radius:3px"></i></div></div>';
      d.querySelectorAll("button").forEach((b) => { b.style.cssText = "background:#111;color:#fff;border:1px solid #333;border-radius:10px;width:40px;height:32px;font-size:14px;cursor:pointer"; });
      d.getElementById("p").onclick = prev; d.getElementById("pl").onclick = toggle; d.getElementById("n").onclick = next;
      d.getElementById("bar").onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); seek((e.clientX - r.left) / r.width); };
      pip.addEventListener("pagehide", () => { pip = null; });
      paintPip();
    } catch (e) { pip = null; toast("couldn't open the pop-out controller"); }
  }

  /* ---------- recommended (shown before you search, so the page isn't empty) ---------- */
  let rec = [], recLoaded = false;
  async function loadRec() {
    if (recLoaded) return; recLoaded = true;
    try { const d = await (await fetch("/api/music/recommended")).json(); rec = d.tracks || []; renderRec(); } catch { recLoaded = false; }
  }
  function renderRec() {
    const box = $("#mrec"); if (!box) return;
    if (!rec.length || results.length) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="lyr-h" style="margin:.5rem 0">RECOMMENDED</div><div class="rgrid">' +
      rec.map((t, i) => `<button class="rcard" data-r="${i}" title="${esc(t.title)} · ${esc(t.artist)}"><img src="${esc(t.thumb)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></button>`).join("") + "</div>";
  }

  /* ---------- data ---------- */
  function addRecent(t) {
    recent = [t, ...recent.filter((x) => key(x) !== key(t))].slice(0, 40);
    store("nexvelo.recent", recent); if (tab() === "recent") renderRecent();
  }
  const savePl = () => store("nexvelo.playlists", playlists);

  /* ---------- rendering ---------- */
  const tab = () => $(".mtabs .on")?.dataset.mt;
  const markNow = () => $$(".trow").forEach((r) => r.classList.toggle("now", !!cur && r.dataset.k === key(cur)));
  const cover = (t) => `<img src="${esc(t.thumb)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
  const row = (t, i, extra = "+") => `<div class="trow" data-i="${i}" data-k="${esc(key(t))}">${cover(t)}<div class="tm"><b>${esc(t.title)}</b><span>${esc(t.artist)} · ${srcName(t.source)}${t.dur ? " · " + fmt(t.dur) : ""}</span></div><button class="ib" data-act="${extra === "+" ? "add" : "rm"}" aria-label="${extra === "+" ? "Add to playlist" : "Remove"}">${extra === "+" ? "+" : "×"}</button></div>`;

  function renderResults(msg) {
    const box = $("#mresults");
    if (msg) { box.innerHTML = `<div class="msg">${esc(msg)}</div>`; return; }
    if (!results.length) { box.innerHTML = '<div class="msg">no matches. try another search.</div>'; return; }
    const b = results[0];
    box.innerHTML =
      `<div class="best" data-i="0" data-k="${esc(key(b))}">${cover(b)}<div class="tm"><small>BEST MATCH · ${srcName(b.source).toUpperCase()}</small><b>${esc(b.title)}</b><span>${esc(b.artist)}${b.dur ? " · " + fmt(b.dur) : ""}</span></div><button class="ib" data-act="add" aria-label="Add to playlist">+</button></div>` +
      results.slice(1).map((t, i) => row(t, i + 1)).join("");
    markNow();
  }
  function renderStatus() {
    const s = lastStatus; if (!s) { $("#msrc").innerHTML = ""; return; }
    $("#msrc").innerHTML = `<span>youtube music: ${s.youtube ? "on" : "off"}</span><span>·</span><span>soundcloud: ${s.soundcloud ? "on" : "off"}</span>`;
  }
  function renderPlaylists() {
    const box = $("#plist");
    if (openPl == null) {
      box.innerHTML = `<form class="newpl" id="newpl"><input type="text" placeholder="new playlist name" maxlength="40" autocomplete="off"><button class="btn primary" type="submit">create</button></form>` +
        (playlists.length ? playlists.map((p) => `<div class="plcard" data-pl="${p.id}"><b>${esc(p.name)}</b><small>${p.tracks.length} track${p.tracks.length === 1 ? "" : "s"}</small></div>`).join("") : '<div class="msg">no playlists yet. create one, then add songs with the + button.</div>');
      return;
    }
    const p = playlists.find((x) => x.id === openPl);
    if (!p) { openPl = null; return renderPlaylists(); }
    box.innerHTML = `<div class="bar"><button class="btn" id="pl-back">‹ back</button><h3>${esc(p.name)}</h3><button class="btn primary" id="pl-play">play all</button><button class="btn danger" id="pl-del">delete</button></div>` +
      (p.tracks.length ? p.tracks.map((t, i) => row(t, i, "x")).join("") : '<div class="msg">this playlist is empty.</div>');
    markNow();
  }
  function renderRecent() {
    $("#rlist").innerHTML = recent.length
      ? `<div class="bar"><h3>recently played</h3><button class="btn" id="r-clear">clear</button></div>` + recent.map((t, i) => row(t, i)).join("")
      : '<div class="msg">nothing played yet.</div>';
    markNow();
  }

  /* ---------- add-to-playlist popover ---------- */
  const pop = $("#pop");
  function showPop(btn, t) {
    const r = btn.getBoundingClientRect();
    pop.innerHTML = (playlists.length ? playlists.map((p) => `<button data-add="${p.id}">${esc(p.name)}</button>`).join("") : '<div class="msg" style="padding:.5rem">no playlists yet</div>') +
      '<input type="text" placeholder="new playlist + enter" maxlength="40">';
    pop.hidden = false;
    pop.style.left = Math.max(8, Math.min(innerWidth - 248, r.right - 240)) + "px";
    pop.style.top = Math.min(innerHeight - 290, r.bottom + 6) + "px";
    pop._t = t;
    $("input", pop).onkeydown = (e) => {
      if (e.key !== "Enter" || !e.target.value.trim()) return;
      const p = { id: "p" + Date.now(), name: e.target.value.trim(), tracks: [] };
      playlists.push(p); addTo(p.id, t); pop.hidden = true;
    };
  }
  function addTo(id, t) {
    const p = playlists.find((x) => x.id === id); if (!p) return;
    if (p.tracks.some((x) => key(x) === key(t))) toast(`already in ${p.name}`);
    else { p.tracks.push(t); toast(`added to ${p.name}`); }
    savePl(); if (tab() === "playlists") renderPlaylists();
  }
  pop.addEventListener("click", (e) => { const b = e.target.closest("[data-add]"); if (b) { addTo(b.dataset.add, pop._t); pop.hidden = true; } });
  document.addEventListener("pointerdown", (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-act="add"]')) pop.hidden = true; });

  /* ---------- panel events ---------- */
  function openMusic(t) {
    if (!settings.music) return;
    window.NV.openPage("music");
    if (t) showTab(t);
  }
  function showTab(t) {
    $$(".mtabs button").forEach((b) => b.classList.toggle("on", b.dataset.mt === t));
    $$(".mt").forEach((m) => m.classList.toggle("on", m.id === "mt-" + t));
    if (t === "playlists") renderPlaylists();
    if (t === "recent") renderRecent();
  }
  $(".mtabs").addEventListener("click", (e) => { const b = e.target.closest("[data-mt]"); if (b) showTab(b.dataset.mt); });
  $("#open-music").addEventListener("click", () => openMusic());

  $("#msearch").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#mq").value.trim(); if (!q) return;
    renderResults("searching youtube music and soundcloud…");
    try {
      const r = await fetch("/api/music/search?q=" + encodeURIComponent(q));
      if (r.status === 404) throw new Error("music search needs the Nex.Velo server (the Railway site), not a static host.");
      const data = await r.json();
      lastStatus = data.status; renderStatus();
      results = data.results || []; renderRec();
      if (!results.length && data.errors && Object.keys(data.errors).length) {
        renderResults("both sources failed: " + Object.entries(data.errors).map(([k, v]) => `${k} (${v})`).join(", "));
      } else renderResults();
    } catch (err) { results = []; renderResults(err.message || "search failed"); }
  });

  document.addEventListener("click", (e) => {
    if (!$("#page-music").contains(e.target)) return;
    const rc = e.target.closest("[data-r]"); if (rc) return playAt(rec.slice(), +rc.dataset.r);
    const addBtn = e.target.closest('[data-act="add"]');
    if (addBtn) { e.stopPropagation(); const el = addBtn.closest("[data-i]"); const t = tab() === "recent" ? recent[+el.dataset.i] : results[+el.dataset.i]; return showPop(addBtn, t); }
    const rm = e.target.closest('[data-act="rm"]');
    if (rm) { const p = playlists.find((x) => x.id === openPl); p.tracks.splice(+rm.closest("[data-i]").dataset.i, 1); savePl(); return renderPlaylists(); }
    const pc = e.target.closest("[data-pl]"); if (pc) { openPl = pc.dataset.pl; return renderPlaylists(); }
    if (e.target.closest("#pl-back")) { openPl = null; return renderPlaylists(); }
    if (e.target.closest("#pl-play")) { const p = playlists.find((x) => x.id === openPl); return p.tracks.length && playAt(p.tracks.slice(), 0); }
    if (e.target.closest("#pl-del")) { if (confirm("delete this playlist?")) { playlists = playlists.filter((x) => x.id !== openPl); openPl = null; savePl(); renderPlaylists(); } return; }
    if (e.target.closest("#r-clear")) { recent = []; store("nexvelo.recent", recent); return renderRecent(); }
    const r = e.target.closest(".trow, .best");
    if (r) {
      const i = +r.dataset.i, t = tab();
      if (t === "search") playAt(results.slice(), i);
      else if (t === "recent") playAt(recent.slice(), i);
      else playAt(playlists.find((x) => x.id === openPl).tracks.slice(), i);
    }
  });
  document.addEventListener("submit", (e) => {
    if (e.target.id !== "newpl") return;
    e.preventDefault();
    const input = $("input", e.target), name = input.value.trim(); if (!name) return;
    playlists.push({ id: "p" + Date.now(), name, tracks: [] }); savePl(); renderPlaylists();
  });

  /* ---------- extension toggle + status chips ---------- */
  function applyMusicToggle() {
    $("#open-music").hidden = !settings.music;
    if (!settings.music && !audio.paused) audio.pause();
    paintMini();
  }
  async function refreshMusicChips() {
    const box = $("#music-chips");
    if (!box) return;
    box.innerHTML = '<span class="chip">checking sources…</span>';
    try {
      const r = await fetch("/api/music/status"); if (!r.ok) throw 0;
      const s = (await r.json()).status;
      box.innerHTML = `<span class="chip ${s.youtube ? "ok" : ""}">youtube music: ${s.youtube ? "connected" : "unavailable"}</span><span class="chip ${s.soundcloud ? "ok" : ""}">soundcloud: ${s.soundcloud ? "connected" : "unavailable"}</span>`;
    } catch { box.innerHTML = '<span class="chip">music server not reachable</span>'; }
  }
  window.NV.onTab = (t) => {
    musicTab = t.kind === "music"; paintMini();
    if (musicTab && cur && lyr.key !== key(cur)) loadLyrics(cur);
    if (musicTab) syncLyrics(true);
    if (musicTab) loadRec();
  };
  window.NV.applyMusicToggle = applyMusicToggle;
  window.NV.refreshMusicChips = refreshMusicChips;
  window.addEventListener("beforeunload", () => persist(true));
  applyMusicToggle();
})();

/* Nex.AI: chat in its own tab with file uploads, screen sharing and voice chat.
   Talks to /api/ai/chat and /api/ai/transcribe (Groq). Chat text stays in this browser. */
(() => {
  "use strict";
  const { esc, toast, LS } = window.NV;
  const $ = (s, r = document) => r.querySelector(s);
  const SYSTEM = "You are Nex.AI, a friendly, concise assistant built into the Nex.Velo web proxy. Use plain language and short answers unless asked for detail. If the user shares their screen or an image, describe and help with what you see.";
  const TEXT_EXT = /\.(txt|md|csv|json|js|ts|py|html|css|java|c|cpp|go|rs|sh|log|xml|ya?ml)$/i;
  let db = { cur: null, model: "openai/gpt-oss-20b", chats: [] };
  try { db = { ...db, ...JSON.parse(LS.get("nexvelo.ai", "{}")) }; } catch {}
  let busy = false, serverKey = null, attachments = [], share = null, voiceOn = false, listening = null;
  const save = () => LS.set("nexvelo.ai", JSON.stringify(db));
  const chat = () => db.chats.find((c) => c.id === db.cur);
  const getKey = () => LS.get("nexvelo.aikey", "");
  const authHeaders = (h = {}) => (getKey() ? { ...h, "x-groq-key": getKey() } : h);

  /* ---------- rendering ---------- */
  function md(t) {
    return String(t).split(/```/).map((p, i) => {
      if (i % 2) return `<pre><code>${esc(p.replace(/^[\w+-]*\n/, "").replace(/\n$/, ""))}</code></pre>`;
      return esc(p).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
    }).join("");
  }
  function renderList() {
    $("#ai-list").innerHTML = db.chats.map((c) => `<button data-id="${c.id}" class="${c.id === db.cur ? "on" : ""}" title="${esc(c.title)}">${esc(c.title)}</button>`).join("");
  }
  function renderMsgs() {
    const c = chat(), box = $("#ai-msgs");
    if (!c || !c.msgs.length) {
      box.innerHTML = '<div class="aiempty"><b style="display:block;font-size:1.125rem;margin-bottom:.5rem;color:var(--fg)">nex.ai</b>ask me anything. attach files or images, share your screen, or press the mic to talk.</div>';
      return;
    }
    box.innerHTML = c.msgs.map((m) => `<div class="aimsg ${m.role === "user" ? "user" : "bot"}">${m.role === "user" ? esc(m.content) : md(m.content)}</div>`).join("");
    box.scrollTop = box.scrollHeight;
  }
  function newChat() {
    const c = { id: "c" + Date.now(), title: "new chat", msgs: [] };
    db.chats.unshift(c); db.cur = c.id; save(); renderList(); renderMsgs(); $("#ai-in").focus();
  }

  /* ---------- attachments + screen share ---------- */
  function shrink(src, max, q) {   // src: HTMLImageElement or HTMLVideoElement
    const w = src.videoWidth || src.naturalWidth, h = src.videoHeight || src.naturalHeight;
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", q);
  }
  function renderAtt() {
    const box = $("#ai-att");
    box.hidden = !attachments.length;
    box.innerHTML = attachments.map((a, i) => `<span>${a.type === "image" ? "🖼" : "📄"} ${esc(a.name)}<button type="button" data-rm="${i}" aria-label="Remove">×</button></span>`).join("");
  }
  async function addFiles(files) {
    for (const f of files) {
      try {
        if (f.type.startsWith("image/")) {
          const url = URL.createObjectURL(f);
          const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
          attachments.push({ type: "image", name: f.name, data: shrink(img, 1280, .8) }); URL.revokeObjectURL(url);
        } else if (f.type.startsWith("text/") || TEXT_EXT.test(f.name)) {
          attachments.push({ type: "text", name: f.name, data: (await f.text()).slice(0, 30000) });
        } else toast(`${f.name}: only images and text files are supported`);
      } catch { toast(`couldn't read ${f.name}`); }
    }
    renderAtt();
  }
  async function toggleShare() {
    if (share) return stopShare();
    if (!navigator.mediaDevices?.getDisplayMedia) return toast("this device can't share its screen");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const v = $("#ai-share-v"); v.srcObject = stream; v.hidden = false; await v.play();
      share = { stream }; $("#ai-screen").classList.add("on");
      stream.getVideoTracks()[0].addEventListener("ended", stopShare);
      toast("sharing your screen. each message includes what is on it right now.");
    } catch { toast("screen share was cancelled"); }
  }
  function stopShare() {
    if (!share) return;
    share.stream.getTracks().forEach((t) => t.stop()); share = null;
    const v = $("#ai-share-v"); v.srcObject = null; v.hidden = true; $("#ai-screen").classList.remove("on");
  }

  /* ---------- sending ---------- */
  async function send(text, spoken) {
    text = (text || "").trim();
    if (busy || (!text && !attachments.length)) return;
    if (!chat()) newChat();
    const c = chat();
    // what the model sees
    let body = text;
    for (const a of attachments.filter((x) => x.type === "text")) body += `\n\n[file: ${a.name}]\n\`\`\`\n${a.data}\n\`\`\``;
    const images = attachments.filter((x) => x.type === "image").map((a) => a.data);
    let screenNote = "";
    if (share) {
      try { images.push(shrink($("#ai-share-v"), 1280, .7)); screenNote = "🖥 screen shared"; } catch {}
    }
    const content = images.length
      ? [{ type: "text", text: body || "What do you see?" }, ...images.map((u) => ({ type: "image_url", image_url: { url: u } }))]
      : body;
    // what we keep (no images, to stay inside the browser's storage)
    const shown = [text, attachments.length ? "📎 " + attachments.map((a) => a.name).join(", ") : "", screenNote].filter(Boolean).join("\n");
    const history = c.msgs.map((m) => ({ role: m.role, content: m.content }));
    c.msgs.push({ role: "user", content: shown });
    if (c.title === "new chat") c.title = (text || attachments[0]?.name || "chat").slice(0, 40);
    const reply = { role: "assistant", content: "" };
    c.msgs.push(reply); attachments = []; renderAtt(); save(); renderList(); renderMsgs();
    busy = true; $("#ai-send").disabled = true;
    const bot = $("#ai-msgs").lastElementChild;
    try {
      const r = await fetch("/api/ai/chat", {
        method: "POST", headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ model: db.model, messages: [{ role: "system", content: SYSTEM }, ...history, { role: "user", content }] }),
      });
      if (!r.ok) {
        let d = {}; try { d = await r.json(); } catch {}
        if (r.status === 404) throw new Error("the ai needs the Nex.Velo server (the Railway site), not a static host.");
        if (d.error === "no_key" || r.status === 401) throw new Error("no api key yet. press the api key button (top right) and paste a free Groq key, or set GROQ_API_KEY on the server.");
        throw new Error(d.error || "the ai service returned an error (" + r.status + ")");
      }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim(); if (data === "[DONE]") continue;
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta?.content;
            if (delta) { reply.content += delta; bot.innerHTML = md(reply.content); $("#ai-msgs").scrollTop = $("#ai-msgs").scrollHeight; }
          } catch {}
        }
      }
      if (!reply.content) reply.content = "(no response)";
    } catch (e) { reply.content = "⚠️ " + (e.message || "something went wrong"); }
    bot.innerHTML = md(reply.content);
    busy = false; $("#ai-send").disabled = false; save();
    if (voiceOn) speak(reply.content); 
  }

  /* ---------- voice chat: record, transcribe on the server, speak the reply ---------- */
  function speak(text) {
    const plain = text.replace(/```[\s\S]*?```/g, " (code omitted) ").replace(/[*`#_]/g, "").slice(0, 1200);
    if (!("speechSynthesis" in window) || text.startsWith("⚠️")) { if (voiceOn) listen(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(plain);
    u.onend = () => { if (voiceOn) listen(); };
    u.onerror = () => { if (voiceOn) listen(); };
    speechSynthesis.speak(u);
  }
  async function listen() {
    if (!voiceOn || busy || listening) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("voice chat isn't supported on this browser"); return stopVoice(); }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast("microphone access was blocked"); return stopVoice(); }
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const chunks = []; let skip = false;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    let started = false, lastLoud = Date.now(); const t0 = Date.now();
    const timer = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
      const now = Date.now();
      if (Math.sqrt(sum / buf.length) > 0.03) { started = true; lastLoud = now; }
      if (started && now - lastLoud > 1300) rec.stop();                 // finished talking
      else if (!started && now - t0 > 12000) { skip = true; rec.stop(); } // nobody spoke, try again
      else if (now - t0 > 45000) rec.stop();
    }, 100);
    listening = { rec, stop: () => { skip = true; try { rec.stop(); } catch {} } };
    $("#ai-voice").classList.add("on"); $("#ai-in").placeholder = "listening…";
    rec.onstop = async () => {
      clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => {}); listening = null;
      $("#ai-in").placeholder = "ask anything";
      if (!voiceOn) return;
      if (skip) return listen();
      $("#ai-in").placeholder = "transcribing…";
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const r = await fetch("/api/ai/transcribe", { method: "POST", headers: authHeaders({ "content-type": blob.type }), body: blob });
        const d = await r.json().catch(() => ({}));
        $("#ai-in").placeholder = "ask anything";
        if (!r.ok) { toast(d.error === "no_key" ? "voice chat needs a Groq api key (see the api key button)" : d.error || "couldn't hear that"); return stopVoice(); }
        if (d.text) send(d.text, true); else listen();
      } catch { $("#ai-in").placeholder = "ask anything"; toast("couldn't reach the server for voice"); stopVoice(); }
    };
    rec.start();
  }
  function toggleVoice() { voiceOn ? stopVoice() : (voiceOn = true, $("#ai-voice").classList.add("on"), listen()); }
  function stopVoice() {
    voiceOn = false; $("#ai-voice").classList.remove("on"); $("#ai-in").placeholder = "ask anything";
    if (listening) listening.stop();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  /* ---------- wiring ---------- */
  const submit = () => { const t = $("#ai-in").value; $("#ai-in").value = ""; $("#ai-in").style.height = "auto"; send(t); };
  $("#ai-form").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  // Enter sends, Shift+Enter makes a new line. beforeinput covers phone keyboards that don't report "Enter".
  $("#ai-in").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  $("#ai-in").addEventListener("beforeinput", (e) => { if ((e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") && !e.isComposing) { e.preventDefault(); submit(); } });
  $("#ai-in").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 144) + "px"; });
  $("#ai-attach").addEventListener("click", () => $("#ai-file").click());
  $("#ai-file").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
  $("#ai-att").addEventListener("click", (e) => { const b = e.target.closest("[data-rm]"); if (b) { attachments.splice(+b.dataset.rm, 1); renderAtt(); } });
  $("#ai-screen").addEventListener("click", toggleShare);
  $("#ai-voice").addEventListener("click", toggleVoice);
  $("#ai-new").addEventListener("click", newChat);
  $("#ai-list").addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (b) { db.cur = b.dataset.id; save(); renderList(); renderMsgs(); } });
  $("#ai-model").addEventListener("change", (e) => { db.model = e.target.value; save(); });
  $("#ai-key-btn").addEventListener("click", () => {
    const note = serverKey ? "The server already has a key, so this is optional.\n\n" : "";
    const k = prompt(note + "Paste your Groq API key. It is stored only in this browser and sent to this site's server for each message. Leave empty to remove it.", getKey());
    if (k === null) return;
    if (k.trim()) { LS.set("nexvelo.aikey", k.trim()); toast("api key saved"); } else { LS.del("nexvelo.aikey"); toast("api key removed"); }
  });

  async function onOpen() {
    $("#ai-model").value = db.model; renderList(); renderMsgs();
    if (serverKey === null) { try { serverKey = (await (await fetch("/api/ai/status")).json()).serverKey; } catch { serverKey = false; } }
  }
  window.NV.onAiOpen = onOpen;
  if (document.querySelector("#views #page-ai")) onOpen();   // restored from a previous visit
})();

/* Games: DuckMath and Weslack, each loaded through the proxy. Switch between them with the tabs. */
(() => {
  "use strict";
  const { LS, proxyFrame, toast } = window.NV;
  const $ = (s, r = document) => r.querySelector(s);
  const SITES = { duckmath: "https://duckmath.org", weslack: "https://weslack.com" };
  const frames = {};
  let cur = (() => { try { return JSON.parse(LS.get("nexvelo.games", "{}")).site; } catch { return null; } })();
  if (!SITES[cur]) cur = "duckmath";
  const msg = (t) => { $("#gmsg").textContent = t || ""; };

  async function show(k) {
    cur = k; LS.set("nexvelo.games", JSON.stringify({ site: k }));
    document.querySelectorAll("#gtabs button").forEach((b) => b.classList.toggle("on", b.dataset.g === k));
    for (const f of Object.values(frames)) f.hidden = true;
    if (!frames[k]) {
      msg("loading " + k + " through the proxy…");
      try {
        const el = await proxyFrame(SITES[k]);
        el.hidden = cur !== k;
        el.addEventListener("load", () => { if (cur === k) msg(""); });
        frames[k] = el; $("#gframes").appendChild(el);
        setTimeout(() => { if (cur === k) msg(""); }, 12000);
      } catch (e) { msg("couldn't start the proxy: " + (e.message || e)); return; }
    }
    frames[k].hidden = false;
  }

  $("#gtabs").addEventListener("click", (e) => { const b = e.target.closest("[data-g]"); if (b) show(b.dataset.g); });
  $("#g-reload").addEventListener("click", () => {
    const f = frames[cur]; if (!f) return show(cur);
    try { f.contentWindow.location.reload(); msg("reloading…"); setTimeout(() => msg(""), 8000); } catch { f.remove(); delete frames[cur]; show(cur); }
  });
  $("#g-open").addEventListener("click", () => window.NV.openUrl(SITES[cur]));

  window.NV.onGamesOpen = () => show(cur);
  if (document.querySelector("#views #page-games")) show(cur);   // restored from a previous visit
})();

/* Servers (inside Settings): keep a list of Wisp servers, test their speed, pick one, or let it pick the fastest. */
(() => {
  "use strict";
  const { esc, toast, LS, settings, defaultWisp, testWisp, normalizeWisp } = window.NV;
  const $ = (s, r = document) => r.querySelector(s);
  let list = []; try { list = JSON.parse(LS.get("nexvelo.servers", "[]")) || []; } catch {}
  const speed = {};   // url -> text
  const ms = {};      // url -> number
  const persist = () => LS.set("nexvelo.servers", JSON.stringify(list));
  const all = () => [{ url: defaultWisp, label: "Nex.Velo server (default)" }, ...list.map((u) => ({ url: u, label: u }))];

  function render() {
    const html =
      `<div class="row" style="margin-bottom:.75rem"><button class="btn sv-best">test all and use the fastest</button></div>` +
      all().map((s) => {
        const on = settings.wisp === s.url;
        return `<div class="sv-row${on ? " on" : ""}" data-u="${esc(s.url)}"><b>${esc(s.label)}</b><small>${esc(speed[s.url] || "")}</small>` +
          `<button class="btn" data-a="test">test</button><button class="btn${on ? "" : " primary"}" data-a="use"${on ? " disabled" : ""}>${on ? "in use" : "use"}</button>` +
          (s.url === defaultWisp ? "" : '<button class="btn danger" data-a="rm">remove</button>') + "</div>";
      }).join("");
    const el = $("#sv2-list"); if (el) el.innerHTML = html;
  }
  async function test(url) {
    speed[url] = "testing…"; render();
    const t0 = performance.now(), ok = await testWisp(url);
    if (ok) { ms[url] = Math.round(performance.now() - t0); speed[url] = ms[url] + " ms"; } else { delete ms[url]; speed[url] = "unreachable"; }
    render(); return ok;
  }
  async function use(url) {
    try { await window.NV.setWisp(url); toast("now using that server"); } catch { toast("couldn't switch servers. reload and try again."); }
    render();
  }

  function bind(formId, inputId, listId) {
    $(formId).addEventListener("submit", (e) => {
      e.preventDefault();
      const url = normalizeWisp($(inputId).value); if (!url) return;
      if (url === defaultWisp || list.includes(url)) toast("that server is already in the list");
      else { list.push(url); persist(); }
      $(inputId).value = ""; render(); test(url);
    });
    $(listId).addEventListener("click", async (e) => {
      if (e.target.closest(".sv-best")) {
        await Promise.all(all().map((s) => test(s.url)));
        const best = Object.entries(ms).sort((a, b) => a[1] - b[1])[0];
        if (best) use(best[0]); else toast("none of the servers were reachable");
        return;
      }
      const b = e.target.closest("[data-a]"); if (!b) return;
      const url = b.closest(".sv-row").dataset.u;
      if (b.dataset.a === "test") test(url);
      else if (b.dataset.a === "use") use(url);
      else if (b.dataset.a === "rm") { list = list.filter((u) => u !== url); persist(); render(); }
    });
  }
  bind("#sv2-form", "#sv2-url", "#sv2-list");
  render();   // fill the list in Settings and on the servers page
})();
