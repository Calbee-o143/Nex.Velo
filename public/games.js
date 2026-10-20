/* Games page: library from the server (/api/games), opened through the proxy in a normal tab. */
(() => {
  "use strict";
  const { esc, toast, LS } = window.NV;
  const $ = (s, r = document) => r.querySelector(s);
  const PAGE = 60;
  let games = null, list = [], shown = 0, loading = false;
  let recent = []; try { recent = JSON.parse(LS.get("nexvelo.games", "[]")) || []; } catch {}

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
    if (!list.length) $("#gmsg").textContent = "no games match that search.";
    else $("#gmsg").textContent = "";
  }
  function more() {
    const next = list.slice(shown, shown + PAGE); shown += next.length;
    $("#ggrid").insertAdjacentHTML("beforeend", next.map((g) => `<button class="gcard" data-id="${esc(g.id)}"><i style="background-image:url('${esc(g.cover)}')"></i><span>${esc(g.name)}</span></button>`).join(""));
    $("#gmore").hidden = shown >= list.length;
  }

  $("#gq").addEventListener("input", () => games && apply());
  $("#gmore").addEventListener("click", more);
  $(".gwrap").addEventListener("scroll", (e) => { const el = e.target; if (!$("#gmore").hidden && el.scrollTop + el.clientHeight > el.scrollHeight - 400) more(); });
  $("#ggrid").addEventListener("click", (e) => {
    const c = e.target.closest(".gcard"); if (!c) return;
    const id = c.dataset.id;
    recent = [id, ...recent.filter((x) => x !== id)].slice(0, 12);
    LS.set("nexvelo.games", JSON.stringify(recent));
    window.NV.openUrl(location.origin + "/play/" + encodeURIComponent(id));
  });
  window.NV.onGamesOpen = load;
  // when the page was restored from a previous visit, load the list right away
  if (document.querySelector("#views #page-games")) load();
})();
