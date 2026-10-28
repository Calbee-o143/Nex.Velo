/* Games: open-source libraries (Cherri Games, GN Math, Obsidian's Unblocked Revamped) and two game sites (DuckMath, Weslack).
   Search, pick a game, and it opens in its own proxied frame, without the site's menus around it. */
(() => {
  "use strict";
  const { LS, proxyFrame, toast, esc, apiBase } = window.NV;
  const $ = (s, r = document) => r.querySelector(s);
  const PAGE = 60;
  const SOURCES = ["cherri", "gn", "obsidian", "duckmath", "weslack"];
  const LABEL = { cherri: "Cherri", gn: "GN Math", obsidian: "Obsidian", duckmath: "DuckMath", weslack: "Weslack" };

  let src = (() => { try { return JSON.parse(LS.get("nexvelo.games", "{}")).src; } catch { return null; } })();
  if (!SOURCES.includes(src)) src = "cherri";
  const lists = {};
  let list = [], shown = 0, current = null;

  // a message, with an optional button that tests every game source on the server and shows exactly what fails and why
  const msg = (t, check) => {
    const el = $("#gmsg"); el.style.whiteSpace = ""; el.textContent = t || "";
    if (!check) return;
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn"; b.textContent = "run full check"; b.style.marginLeft = ".5rem";
    b.addEventListener("click", runCheck); el.appendChild(b);
  };
  async function runCheck() {
    const el = $("#gmsg"); el.style.whiteSpace = "pre-wrap"; el.textContent = "checking every game source… this can take up to a minute";
    try {
      const d = await (await fetch(abs("/api/diag"))).json();
      const keys = ["gnMath", "gnFile", "cherri", "cherriFile", "obsidian", "obsidianFile", "duckmath", "weslack"];
      el.textContent = keys.filter((k) => d.checks[k]).map((k) => { const v = d.checks[k]; return `${v.ok ? "✓" : "✗"} ${k} (${v.ms} ms) ${v.ok ? v.info : v.error}`; }).join("\n");
    } catch { el.textContent = "couldn't reach /api/diag. the server may be on an older version. redeploy the newest lib/api.js."; }
  }
  // always a full address, so it works the same whether the page and the server share a host or not
  const abs = (p) => new URL(/^https?:/i.test(p) ? p : apiBase() + p, location.href).href;

  // the Obsidian tab is added here, so the page's HTML doesn't need to change
  (() => {
    const tabs = $("#gtabs"); if (!tabs || tabs.querySelector('[data-g="obsidian"]')) return;
    const sample = tabs.querySelector("button"); if (!sample) return;
    const b = document.createElement("button");
    b.type = "button"; b.className = sample.className.replace(/\bon\b/, "").trim(); b.dataset.g = "obsidian"; b.textContent = LABEL.obsidian;
    const after = tabs.querySelector('[data-g="gn"]');
    after ? after.insertAdjacentElement("afterend", b) : tabs.appendChild(b);
  })();

  async function load(key) {
    if (lists[key]) return lists[key];
    msg("loading the " + (LABEL[key] || key) + " games…");
    try {
      const r = await fetch(abs("/api/games/list?src=" + key));
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.games?.length) throw new Error(d.error || "the server answered " + r.status);
      return (lists[key] = d.games);
    } catch (e) { msg("couldn't load the " + (LABEL[key] || key) + " games. " + (e.message || e), true); return null; }
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
    else if (g.url && /^https?:/i.test(g.url) && src !== "duckmath" && src !== "weslack") { target = g.url; isolated = false; } // a plain link: open it through the proxy
    else if (g.url && /^https?:/i.test(g.url)) {
      try {
        const d = await (await fetch(abs(`/api/games/open?site=${src}&url=${encodeURIComponent(g.url)}`))).json();
        if (d.embed) target = d.embed; else { target = g.url; isolated = false; }
      } catch { target = g.url; isolated = false; }
    }
    if (!target) { $("#gvmsg").textContent = "couldn't find that game's address."; return; }
    g._target = target;
    try {
      let el;
      if (g.play) {
        // Library games are files on the Nex.Velo server itself, so they open directly. The proxy would only add rewriting that breaks games.
        el = document.createElement("iframe");
        el.src = target; el.allow = "fullscreen; autoplay; gamepad; clipboard-write; accelerometer; gyroscope";
        el.setAttribute("allowfullscreen", ""); el.style.cssText = "width:100%;height:100%;border:0;background:#000";
      } else el = await proxyFrame(target);
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

  window.NV.onGamesOpen = () => {
    document.querySelectorAll("#gtabs button").forEach((b) => b.classList.toggle("on", b.dataset.g === src));
    if (!lists[src]) showSource(src);
  };
  if (document.querySelector("#views #page-games")) window.NV.onGamesOpen(); // restored from a previous visit
  window.NV.loaded.games = true;
})();
