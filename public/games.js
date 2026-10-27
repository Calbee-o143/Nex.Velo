/* Games: open-source libraries (Cherri Games, GN Math) and two game sites (DuckMath, Weslack).
   Search, pick a game, and it opens in its own proxied frame, without the site's menus around it. */
(() => {
  "use strict";
  const { LS, proxyFrame, toast, esc, apiBase } = window.NV;
  const $ = (s, r = document) => r.querySelector(s);
  const PAGE = 60;
  let src = (() => { try { return JSON.parse(LS.get("nexvelo.games", "{}")).src; } catch { return null; } })();
  if (!["cherri", "gn", "duckmath", "weslack"].includes(src)) src = "cherri";
  const lists = {};
  let list = [], shown = 0, current = null;
  const msg = (t) => { $("#gmsg").textContent = t || ""; };
  const abs = (p) => (/^https?:/i.test(p) ? p : apiBase() + p);

  async function load(key) {
    if (lists[key]) return lists[key];
    msg("loading the " + key + " games…");
    try {
      const r = await fetch("/api/games/list?src=" + key);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.games?.length) throw new Error(d.error || "the server answered " + r.status);
      return (lists[key] = d.games);
    } catch (e) { msg("couldn't load the " + key + " games. " + (e.message || e)); return null; }
  }

  async function showSource(key) {
    src = key; LS.set("nexvelo.games", JSON.stringify({ src }));
    document.querySelectorAll("#gtabs button").forEach((b) => b.classList.toggle("on", b.dataset.g === key));
    $("#ggrid").innerHTML = ""; $("#gcount").textContent = ""; $("#gmore").hidden = true;
    const games = await load(key);
    if (src !== key || !games) return;
    msg(""); filter();
  }
  function filter() {
    const games = lists[src] || [], q = $("#gq").value.trim().toLowerCase();
    list = q ? games.filter((g) => g.name.toLowerCase().includes(q)) : games;
    shown = 0; $("#ggrid").innerHTML = ""; more();
    $("#gcount").textContent = `${list.length} game${list.length === 1 ? "" : "s"}`;
    msg(list.length ? "" : "no games match that search.");
  }
  function more() {
    const next = list.slice(shown, shown + PAGE);
    const start = shown; shown += next.length;
    $("#ggrid").insertAdjacentHTML("beforeend", next.map((g, i) => {
      const hue = [...g.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
      const bg = g.thumb ? `background-image:url('${esc(abs(g.thumb))}')` : `background-image:linear-gradient(135deg,hsl(${hue} 55% 38%),hsl(${(hue + 50) % 360} 55% 24%))`;
      return `<button class="gcard" data-i="${start + i}"><i style="${bg}">${g.thumb ? "" : esc(g.name.trim()[0] || "?")}</i><span>${esc(g.name)}</span></button>`;
    }).join(""));
    $("#gmore").hidden = shown >= list.length;
  }

  async function play(g) {
    current = g;
    $("#g-browse").hidden = true; $("#g-view").hidden = false;
    $("#g-title").textContent = g.name; $("#gplay").innerHTML = ""; $("#gvmsg").textContent = "opening " + g.name + "…";
    let target = null, isolated = true;
    if (g.play) target = abs(g.play);
    else if (g.url && /^https?:/i.test(g.url) && !lists[src]?.some?.((x) => x === g && x.site)) {
      try {
        const d = await (await fetch(`/api/games/open?site=${src}&url=${encodeURIComponent(g.url)}`)).json();
        if (d.embed) target = d.embed; else { target = g.url; isolated = false; }
      } catch { target = g.url; isolated = false; }
    }
    if (!target) { $("#gvmsg").textContent = "couldn't find that game's address."; return; }
    g._target = target;
    try {
      const el = await proxyFrame(target);
      el.addEventListener("load", () => { $("#gvmsg").textContent = ""; });
      $("#gplay").appendChild(el);
      setTimeout(() => { $("#gvmsg").textContent = ""; }, 12000);
      if (!isolated) toast("couldn't isolate the game, showing its page");
    } catch (e) { $("#gvmsg").textContent = "couldn't start the proxy: " + (e.message || e); }
  }
  function back() { $("#gplay").innerHTML = ""; $("#g-view").hidden = true; $("#g-browse").hidden = false; current = null; }

  $("#gtabs").addEventListener("click", (e) => { const b = e.target.closest("[data-g]"); if (b) { back(); showSource(b.dataset.g); } });
  $("#gq").addEventListener("input", filter);
  $("#gmore").addEventListener("click", more);
  $("#ggrid").addEventListener("click", (e) => { const c = e.target.closest(".gcard"); if (c) play(list[+c.dataset.i]); });
  $("#g-back").addEventListener("click", back);
  $("#g-reload").addEventListener("click", () => {
    const f = $("#gplay iframe"); if (!f || !current) return;
    try { f.contentWindow.location.reload(); } catch { play(current); }
  });
  $("#g-open").addEventListener("click", () => { if (current?._target) window.NV.openUrl(current._target); });
  $(".gscroll", $("#page-games")).addEventListener("scroll", (e) => { const el = e.target; if (!$("#gmore").hidden && el.scrollTop + el.clientHeight > el.scrollHeight - 400) more(); });

  window.NV.onGamesOpen = () => { if (!lists[src]) showSource(src); };
  if (document.querySelector("#views #page-games")) window.NV.onGamesOpen();   // restored from a previous visit
  window.NV.loaded.games = true;
})();
