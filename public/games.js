/* Games page: GN Math library (via the server) and the Lumin widget. GN Math games open through the proxy in their own tab. */
(() => {
  "use strict";
  const { esc, LS } = window.NV;
  const $ = (s, r = document) => r.querySelector(s);
  const PAGE = 60;
  let mode = "gn", games = null, list = [], shown = 0, loading = false, luminLoaded = false;
  let recent = []; try { recent = JSON.parse(LS.get("nexvelo.games", "[]")) || []; } catch {}

  /* ----- GN Math ----- */
  async function load() {
    if (games || loading) return;
    loading = true; $("#gmsg").textContent = "loading games…";
    try {
      const r = await fetch("/api/games");
      let d = {}; try { d = await r.json(); } catch {}
      if (r.status === 404) throw new Error("games need the Nex.Velo server (the Railway site), not a static host.");
      if (!r.ok || !d.games?.length) throw new Error((d.errors || []).slice(0, 2).join(" | ") || "the server returned no games");
      games = d.games; $("#gmsg").textContent = ""; apply();
    } catch (e) { $("#gmsg").textContent = "couldn't load the game list. " + e.message; }
    loading = false;
  }
  function apply() {
    const q = $("#gq").value.trim().toLowerCase();
    if (q) list = games.filter((g) => g.name.toLowerCase().includes(q));
    else {
      const rec = recent.map((id) => games.find((g) => g.id === id)).filter(Boolean);
      list = [...rec, ...games.filter((g) => !rec.includes(g))];
    }
    shown = 0; $("#ggrid").innerHTML = ""; more();
    $("#gcount").textContent = `${list.length} game${list.length === 1 ? "" : "s"}`;
    $("#gmsg").textContent = list.length ? "" : "no games match that search.";
  }
  function more() {
    const next = list.slice(shown, shown + PAGE); shown += next.length;
    $("#ggrid").insertAdjacentHTML("beforeend", next.map((g) => `<button class="gcard" data-id="${esc(g.id)}"><i style="background-image:url('${esc(g.cover)}')"></i><span>${esc(g.name)}</span></button>`).join(""));
    $("#gmore").hidden = shown >= list.length;
  }
  $("#gq").addEventListener("input", () => games && apply());
  $("#gmore").addEventListener("click", more);
  $(".gwrap", $("#page-games")).addEventListener("scroll", (e) => { const el = e.target; if (mode === "gn" && !$("#gmore").hidden && el.scrollTop + el.clientHeight > el.scrollHeight - 400) more(); });
  $("#ggrid").addEventListener("click", (e) => {
    const c = e.target.closest(".gcard"); if (!c) return;
    const id = c.dataset.id;
    recent = [id, ...recent.filter((x) => x !== id)].slice(0, 12);
    LS.set("nexvelo.games", JSON.stringify(recent));
    window.NV.openUrl(location.origin + "/play/" + encodeURIComponent(id));
  });

  /* ----- Lumin widget (script is served from our own server so a blocked CDN doesn't matter) ----- */
  async function loadLumin() {
    if (luminLoaded) return;
    luminLoaded = true; $("#lmsg").textContent = "loading lumin…";
    try {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "/vendor/lumin.js"; s.onload = res; s.onerror = () => rej(new Error("the lumin script couldn't be loaded"));
        document.head.appendChild(s);
      });
      if (!window.Lumin) throw new Error("the lumin script didn't start");
      window.Lumin.init({
        container: "#lumin-box", theme: "dark", columns: 6, rows: 4,
        onReady: () => { $("#lmsg").textContent = ""; },
        onError: (e) => { $("#lmsg").textContent = "lumin couldn't load its games: " + (e && e.message ? e.message : e); },
      });
      setTimeout(() => { if ($("#lmsg").textContent === "loading lumin…") $("#lmsg").textContent = ""; }, 6000);
    } catch (e) { luminLoaded = false; $("#lmsg").textContent = e.message; }
  }

  /* ----- tabs ----- */
  $("#gtabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-g]"); if (!b) return;
    mode = b.dataset.g;
    document.querySelectorAll("#gtabs button").forEach((x) => x.classList.toggle("on", x === b));
    $("#g-gn").hidden = mode !== "gn"; $("#g-lumin").hidden = mode !== "lumin";
    $("#gq").hidden = $("#gcount").hidden = mode !== "gn";
    mode === "gn" ? load() : loadLumin();
  });

  window.NV.onGamesOpen = () => { mode === "gn" ? load() : loadLumin(); };
  if (document.querySelector("#views #page-games")) window.NV.onGamesOpen();   // restored from a previous visit
})();
