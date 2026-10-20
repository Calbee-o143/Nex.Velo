/* Music: search YouTube Music + SoundCloud, playlists, recently played. */
(() => {
  "use strict";
  const { settings, esc, toast, musicModal, LS } = window.NV;
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
  let results = [], lastStatus = null, openPl = null;

  /* ---------- engines (YouTube embed + SoundCloud widget) ---------- */
  const yt = { p: null, ready: null }, sc = { w: null, ready: null };
  let cur = null, queue = [], qi = -1, playing = false, pos = 0, dur = 0;

  const ytLoad = () => (yt.ready ||= new Promise((res, rej) => {
    if (window.YT && YT.Player) return res();
    window.onYouTubeIframeAPIReady = res;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api"; s.onerror = () => rej(new Error("the youtube player is blocked on this network"));
    document.head.appendChild(s);
  }));
  async function ytPlay(t) {
    await ytLoad();
    if (!yt.p) {
      await new Promise((res) => {
        yt.p = new YT.Player("yt", {
          width: "200", height: "200", videoId: t.id,
          playerVars: { autoplay: 1, playsinline: 1, controls: 0, rel: 0 },
          events: {
            onReady: (e) => { e.target.playVideo(); res(); },
            onStateChange: (e) => { if (cur?.source !== "youtube") return; if (e.data === 1) setPlaying(true); else if (e.data === 2) setPlaying(false); else if (e.data === 0) next(); },
            onError: () => { toast("that track can't be played here. skipping."); next(); },
          },
        });
      });
    } else yt.p.loadVideoById(t.id);
  }

  const scLoad = () => (sc.ready ||= new Promise((res, rej) => {
    if (window.SC && SC.Widget) return res();
    const s = document.createElement("script");
    s.src = "https://w.soundcloud.com/player/api.js"; s.onload = res; s.onerror = () => rej(new Error("the soundcloud player is blocked on this network"));
    document.head.appendChild(s);
  }));
  async function scPlay(t) {
    await scLoad();
    if (!sc.w) {
      const f = document.createElement("iframe");
      f.id = "sc-frame"; f.allow = "autoplay";
      f.src = "https://w.soundcloud.com/player/?auto_play=true&url=" + encodeURIComponent(t.id);
      document.body.appendChild(f);
      sc.w = SC.Widget(f);
      const E = SC.Widget.Events;
      sc.w.bind(E.PLAY, () => { if (cur?.source === "soundcloud") setPlaying(true); });
      sc.w.bind(E.PAUSE, () => { if (cur?.source === "soundcloud") setPlaying(false); });
      sc.w.bind(E.FINISH, () => { if (cur?.source === "soundcloud") next(); });
      sc.w.bind(E.PLAY_PROGRESS, (d) => { if (cur?.source === "soundcloud") { pos = d.currentPosition / 1000; paintProgress(); } });
      sc.w.bind(E.ERROR, () => { toast("that track can't be played here. skipping."); next(); });
      sc.w.bind(E.READY, () => sc.w.getDuration((ms) => { if (cur?.source === "soundcloud") dur = ms / 1000; }));
    } else sc.w.load(t.id, { auto_play: true, callback: () => { sc.w.play(); sc.w.getDuration((ms) => { dur = ms / 1000; }); } });
  }

  setInterval(() => {
    if (cur?.source === "youtube" && yt.p?.getCurrentTime) {
      pos = yt.p.getCurrentTime() || 0; dur = yt.p.getDuration() || cur.dur || dur; paintProgress();
    }
  }, 500);

  /* ---------- playback control ---------- */
  async function playAt(list, i) {
    const t = list[i]; if (!t) return;
    queue = list; qi = i; cur = t; pos = 0; dur = t.dur || 0;
    try { cur.source === "youtube" ? sc.w?.pause() : yt.p?.pauseVideo?.(); } catch {}
    setPlaying(true); addRecent(t); paintMini(); markNow();
    try { t.source === "youtube" ? await ytPlay(t) : await scPlay(t); }
    catch (e) { setPlaying(false); toast(e.message || "couldn't play that"); }
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, artwork: t.thumb ? [{ src: t.thumb }] : [] });
    }
  }
  const setPlaying = (v) => { playing = v; $("#m-play").innerHTML = v ? ICON.pause : ICON.play; };
  function toggle() {
    if (!cur) return;
    if (cur.source === "youtube") playing ? yt.p?.pauseVideo() : yt.p?.playVideo();
    else sc.w?.toggle();
  }
  function next() { if (qi < queue.length - 1) playAt(queue, qi + 1); else setPlaying(false); }
  function prev() { if (pos > 4) seek(0); else if (qi > 0) playAt(queue, qi - 1); else seek(0); }
  function seek(frac) {
    if (!cur || !dur) return;
    if (cur.source === "youtube") yt.p?.seekTo(frac * dur, true); else sc.w?.seekTo(frac * dur * 1000);
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", toggle); navigator.mediaSession.setActionHandler("pause", toggle);
    navigator.mediaSession.setActionHandler("nexttrack", next); navigator.mediaSession.setActionHandler("previoustrack", prev);
  }

  /* ---------- mini player ---------- */
  function paintMini() {
    $("#mini").hidden = !cur || !settings.music;
    if (!cur) return;
    const c = $("#mini-cov"); c.src = cur.thumb || ""; c.style.visibility = cur.thumb ? "visible" : "hidden";
    $("#mini-t").textContent = cur.title; $("#mini-a").textContent = `${cur.artist} · ${srcName(cur.source)}`;
  }
  function paintProgress() { $("#prog i").style.width = dur ? Math.min(100, (pos / dur) * 100) + "%" : "0"; }
  $("#m-play").addEventListener("click", toggle);
  $("#m-next").addEventListener("click", next);
  $("#m-prev").addEventListener("click", prev);
  $("#mini-info").addEventListener("click", () => openMusic());
  $("#prog").addEventListener("pointerdown", (e) => { const r = e.currentTarget.getBoundingClientRect(); seek((e.clientX - r.left) / r.width); });
  $("#m-play").innerHTML = ICON.play;

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
    if (t) showTab(t);
    musicModal.open();
  }
  function showTab(t) {
    $$(".mtabs button").forEach((b) => b.classList.toggle("on", b.dataset.mt === t));
    $$(".mt").forEach((m) => m.classList.toggle("on", m.id === "mt-" + t));
    if (t === "playlists") renderPlaylists(); if (t === "recent") renderRecent();
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
    if (!$("#music").contains(e.target)) return;
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
    if (!settings.music) { musicModal.close(); try { cur && toggle(); } catch {} }
    paintMini();
  }
  async function refreshMusicChips() {
    const box = $("#music-chips");
    box.innerHTML = '<span class="chip">checking sources…</span>';
    try {
      const r = await fetch("/api/music/status"); if (!r.ok) throw 0;
      const s = (await r.json()).status;
      box.innerHTML = `<span class="chip ${s.youtube ? "ok" : ""}">youtube music: ${s.youtube ? "connected" : "unavailable"}</span><span class="chip ${s.soundcloud ? "ok" : ""}">soundcloud: ${s.soundcloud ? "connected" : "unavailable"}</span>`;
    } catch { box.innerHTML = '<span class="chip">music server not reachable</span>'; }
  }
  window.NV.applyMusicToggle = applyMusicToggle;
  window.NV.refreshMusicChips = refreshMusicChips;
  applyMusicToggle();
})();
