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
  const srcFor = (t) => `/api/music/stream?source=${t.source}&id=${encodeURIComponent(t.id)}`;
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
      results = data.results || [];
      if (!results.length && data.errors && Object.keys(data.errors).length) {
        renderResults("both sources failed: " + Object.entries(data.errors).map(([k, v]) => `${k} (${v})`).join(", "));
      } else renderResults();
    } catch (err) { results = []; renderResults(err.message || "search failed"); }
  });

  document.addEventListener("click", (e) => {
    if (!$("#page-music").contains(e.target)) return;
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
  };
  window.NV.applyMusicToggle = applyMusicToggle;
  window.NV.refreshMusicChips = refreshMusicChips;
  window.addEventListener("beforeunload", () => persist(true));
  applyMusicToggle();
})();
