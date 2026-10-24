@@ -1,4 +1,4 @@
/* Music: search YouTube Music + SoundCloud, playlists, recently played. */
/* Music: search YouTube Music + SoundCloud, play through the Nex.Velo server, playlists, recently played. */
(() => {
  "use strict";
  const { settings, esc, toast, musicModal, LS } = window.NV;
@@ -18,101 +18,88 @@
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
  /* ---------- saved player state ---------- */
  const saved = load("nexvelo.music", {});          // {collapsed, cur, queue, qi, pos}
  let collapsed = !!saved.collapsed;
  let cur = saved.cur || null, queue = saved.queue || [], qi = saved.qi ?? -1, playing = false, pos = saved.pos || 0, dur = saved.cur?.dur || 0;
  let resumeAt = pos, lastSave = 0;
  const persist = (force) => {
    const now = Date.now(); if (!force && now - lastSave < 4000) return; lastSave = now;
    store("nexvelo.music", { collapsed, cur, queue: queue.slice(0, 100), qi, pos });
  };

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
  audio.addEventListener("timeupdate", () => { pos = audio.currentTime || 0; if (isFinite(audio.duration)) dur = audio.duration; paintProgress(); persist(); });
  audio.addEventListener("error", () => onFail());

  setInterval(() => {
    if (cur?.source === "youtube" && yt.p?.getCurrentTime) {
      pos = yt.p.getCurrentTime() || 0; dur = yt.p.getDuration() || cur.dur || dur; paintProgress();
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
          queue[qi] = alt; cur = alt; paintMini(); toast("youtube blocked that one, playing the soundcloud version");
          audio.src = srcFor(alt); audio.play().catch(() => {}); return;
        }
      } catch {}
    }
  }, 500);
    setPlaying(false); toast("couldn't play that track. try another.");
  }

  /* ---------- playback control ---------- */
  async function playAt(list, i) {
  function playAt(list, i) {
    const t = list[i]; if (!t) return;
    queue = list; qi = i; cur = t; pos = 0; dur = t.dur || 0;
    try { cur.source === "youtube" ? sc.w?.pause() : yt.p?.pauseVideo?.(); } catch {}
    setPlaying(true); addRecent(t); paintMini(); markNow();
    try { t.source === "youtube" ? await ytPlay(t) : await scPlay(t); }
    catch (e) { setPlaying(false); toast(e.message || "couldn't play that"); }
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, artwork: t.thumb ? [{ src: t.thumb }] : [] });
    }
    queue = list; qi = i; cur = t; pos = 0; dur = t.dur || 0; resumeAt = 0;
    audio.src = srcFor(t);
    audio.play().catch(() => onFail());
    addRecent(t); paintMini(); markNow(); persist(true);
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, artwork: t.thumb ? [{ src: t.thumb }] : [] });
  }
  const setPlaying = (v) => { playing = v; $("#m-play").innerHTML = v ? ICON.pause : ICON.play; };
  function toggle() {
    if (!cur) return;
    if (cur.source === "youtube") playing ? yt.p?.pauseVideo() : yt.p?.playVideo();
    else sc.w?.toggle();
    if (!audio.src) { audio.src = srcFor(cur); resumeAt = pos; }   // restored from last visit
    audio.paused ? audio.play().catch(() => onFail()) : audio.pause();
  }
  function next() { if (qi < queue.length - 1) playAt(queue, qi + 1); else setPlaying(false); }
  function next() { if (qi < queue.length - 1) playAt(queue, qi + 1); else { setPlaying(false); } }
  function prev() { if (pos > 4) seek(0); else if (qi > 0) playAt(queue, qi - 1); else seek(0); }
  function seek(frac) {
    if (!cur || !dur) return;
    if (cur.source === "youtube") yt.p?.seekTo(frac * dur, true); else sc.w?.seekTo(frac * dur * 1000);
  }
  function seek(frac) { if (!cur || !dur) return; if (!audio.src) { audio.src = srcFor(cur); } pos = frac * dur; audio.currentTime = pos; paintProgress(); }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", toggle); navigator.mediaSession.setActionHandler("pause", toggle);
    navigator.mediaSession.setActionHandler("nexttrack", next); navigator.mediaSession.setActionHandler("previoustrack", prev);
  }

  /* ---------- mini player ---------- */
  /* ---------- mini player (can be folded away with the arrow) ---------- */
  function paintMini() {
    $("#mini").hidden = !cur || !settings.music;
    const show = !!cur && settings.music;
    $("#mini").hidden = !show || collapsed;
    $("#m-open").hidden = !show || !collapsed;
    if (!cur) return;
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
@@ -201,7 +188,8 @@
  function showTab(t) {
    $$(".mtabs button").forEach((b) => b.classList.toggle("on", b.dataset.mt === t));
    $$(".mt").forEach((m) => m.classList.toggle("on", m.id === "mt-" + t));
    if (t === "playlists") renderPlaylists(); if (t === "recent") renderRecent();
    if (t === "playlists") renderPlaylists();
    if (t === "recent") renderRecent();
  }
  $(".mtabs").addEventListener("click", (e) => { const b = e.target.closest("[data-mt]"); if (b) showTab(b.dataset.mt); });
  $("#open-music").addEventListener("click", () => openMusic());
@@ -251,11 +239,12 @@
  /* ---------- extension toggle + status chips ---------- */
  function applyMusicToggle() {
    $("#open-music").hidden = !settings.music;
    if (!settings.music) { musicModal.close(); try { cur && toggle(); } catch {} }
    if (!settings.music) { musicModal.close(); if (!audio.paused) audio.pause(); }
    paintMini();
  }
  async function refreshMusicChips() {
    const box = $("#music-chips");
    if (!box) return;
    box.innerHTML = '<span class="chip">checking sources…</span>';
    try {
      const r = await fetch("/api/music/status"); if (!r.ok) throw 0;
@@ -265,5 +254,6 @@
  }
  window.NV.applyMusicToggle = applyMusicToggle;
  window.NV.refreshMusicChips = refreshMusicChips;
  window.addEventListener("beforeunload", () => persist(true));
  applyMusicToggle();
})();
