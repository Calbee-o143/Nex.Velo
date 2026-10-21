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

  /* ================= Settings ================= */
  const defaultWisp = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wisp/`;
  const settings = {
    wisp: defaultWisp, engine: "https://duckduckgo.com/?q=%s", adblock: true,
    theme: "black", wall: "none", wallUrl: "", blur: true, blurAmt: 14,
    clock: true, h24: true, music: true, games: true, ai: true, name: "",
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
  const THEMES = [["black", "midnight", "#0a0a0b"], ["white", "paper", "#f6f6f4"], ["sage", "sage", "#c9dcc0"], ["lavender", "lavender", "#d4c9ec"], ["rose", "rose", "#f2c6cd"], ["sky", "sky", "#c3dcf2"], ["peach", "peach", "#f6d2b8"]];
  const WALLS = { none: null, forest: () => NVWalls.forest(), ocean: () => NVWalls.ocean(), sky: () => NVWalls.sky() };
  const wallCache = {};
  const wallData = () => LS.get("nexvelo.wallpaper", "");
  const wallSrc = (k) => (k === "custom" ? wallData() || settings.wallUrl : (wallCache[k] ??= WALLS[k] ? WALLS[k]() : null));

  function applyTheme() { document.documentElement.dataset.theme = settings.theme; }
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
    if (settings.panicMode === "new") { window.open(dest, "_blank", "noopener"); location.replace("about:blank"); }
    else location.replace(dest);
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
  const PAGES = { settings: $("#page-settings"), music: $("#page-music"), ai: $("#page-ai"), games: $("#page-games"), servers: $("#page-servers") };
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
      t.view.innerHTML = `<div class="home"><div class="clock"><div class="time"><span class="h"></span><i>:</i><span class="m"></span></div><div class="g"></div></div><form class="omni"><input type="text" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="Search or enter address" aria-label="Search or enter address"></form></div>`;
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
    paintChip(t); select(t); tickClock();
    if (kind === "settings") loadSettingsUI();
    if (kind === "ai" && NV.onAiOpen) NV.onAiOpen();
    if (kind === "games" && NV.onGamesOpen) NV.onGamesOpen();
    if (kind === "servers" && NV.onServersOpen) NV.onServersOpen();
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
    if (al) { if (al[1]) openPage(al[1]); return; }
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
    $("#swatches").innerHTML = THEMES.map(([id, label, c]) => `<button class="sw${settings.theme === id ? " on" : ""}" data-theme="${id}"><i style="--c:${c}"></i>${label}</button>`).join("");
    const walls = [["none", "none"], ["forest", "forest"], ["ocean", "ocean"], ["sky", "sky"], ["custom", "custom"]];
    $("#walls").innerHTML = walls.map(([id, label]) => {
      const src = id === "none" ? null : wallSrc(id);
      const thumb = src && /^(https?:|data:image\/)/i.test(src) ? `style="background-image:url('${src.replace(/'/g, "%27")}')"` : "";
      return `<button class="wt${settings.wall === id ? " on" : ""}" data-wall="${id}"><i ${thumb}>${thumb ? "" : id === "none" ? "–" : id === "custom" ? "+" : ""}</i>${label}</button>`;
    }).join("");
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
    $("#wisp-url").value = settings.wisp; $("#engine").value = settings.engine;
    $("#adblock").checked = settings.adblock; $("#clock").checked = settings.clock; $("#h24").checked = settings.h24;
    $("#blur").checked = settings.blur; $("#blur-amt").value = settings.blurAmt; $("#wall-url").value = settings.wallUrl;
    $("#panic-on").checked = settings.panicOn; $("#panic-key").textContent = settings.panicKey; $("#panic-site").value = settings.panicSite; $("#panic-url").value = settings.panicUrl; $("#panic-url-fld").hidden = settings.panicSite !== "custom"; $("#panic-mode").value = settings.panicMode; $("#music-on").checked = settings.music; $("#games-on").checked = settings.games; $("#ai-on").checked = settings.ai; $("#name").value = settings.name;
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
    ["#open-servers", "pick or add the wisp server that carries your traffic."],
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
    settings, save, esc, toast, spring, openSettings, openPage, openUrl: (u) => newTab({ url: u }), LS, defaultWisp, testWisp, normalizeWisp,
    setWisp: async (url) => { settings.wisp = url; save(); $("#wisp-url").value = url; await applyTransport(); },
  };
  applyTheme(); applyWall();
  $("#open-games").hidden = !settings.games;
  $("#open-ai").hidden = !settings.ai;
  $("#open-ai").addEventListener("click", () => openPage("ai"));
  $("#open-games").addEventListener("click", () => openPage("games"));
  $("#open-servers").addEventListener("click", () => openPage("servers"));
  $("#logo").addEventListener("click", () => newTab());
  restoring = true;
  let saved = null; try { saved = JSON.parse(LS.get("nexvelo.tabs", "null")); } catch {}
  if (saved && saved.t && saved.t.length) {
    saved.t.forEach((x) => { if (x.k === "web" || PAGES[x.k]) if (!(PAGES[x.k] && tabs.some((t) => t.kind === x.k))) newTab({ kind: x.k, url: x.u, lazy: true }); });
  }
  restoring = false;
  if (!tabs.length) newTab(); else select(tabs[Math.min(Math.max(saved.a, 0), tabs.length - 1)] || tabs[0]);
})();
