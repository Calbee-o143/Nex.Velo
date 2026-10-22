/* Games: Poki, DuckMath and Weslack, each loaded through the proxy. Switch between them with the tabs. */
(() => {
  "use strict";
  const { settings, save, toast, LS, proxyFrame, openUrl } = Object.assign({}, window.NV);
  const $ = (s, r = document) => r.querySelector(s);
  const SITES = {
    poki: () => "https://poki.com",
    duckmath: () => "https://duckmath.org",
    weslack: () => settings.weslackUrl,
  };
  const frames = {};
  let cur = (() => { try { return JSON.parse(LS.get("nexvelo.games", "{}")).site; } catch { return null; } })();
  if (!SITES[cur]) cur = "poki";

  const msg = (t) => { $("#gmsg").textContent = t || ""; };

  async function show(k) {
    cur = k; LS.set("nexvelo.games", JSON.stringify({ site: k }));
    document.querySelectorAll("#gtabs button").forEach((b) => b.classList.toggle("on", b.dataset.g === k));
    for (const f of Object.values(frames)) f.hidden = true;
    const url = SITES[k]();
    $("#g-setup").hidden = !(k === "weslack");
    if (!url) { msg("add the weslack address above to load it."); return; }
    $("#g-wurl").value = k === "weslack" ? url : "";
    if (!frames[k]) {
      msg("loading " + k + " through the proxy…");
      try {
        const el = await proxyFrame(url);
        el.hidden = cur !== k;
        el.addEventListener("load", () => { if (cur === k) msg(""); });
        frames[k] = el; $("#gframes").appendChild(el);
        setTimeout(() => { if (cur === k) msg(""); }, 12000);
      } catch (e) { msg("couldn't start the proxy: " + (e.message || e)); return; }
    }
    frames[k].hidden = false;
    if (frames[k].contentDocument?.readyState === "complete") msg("");
  }

  $("#gtabs").addEventListener("click", (e) => { const b = e.target.closest("[data-g]"); if (b) show(b.dataset.g); });
  $("#g-reload").addEventListener("click", () => {
    const f = frames[cur]; if (!f) return show(cur);
    try { f.contentWindow.location.reload(); msg("reloading…"); setTimeout(() => msg(""), 8000); } catch { f.remove(); delete frames[cur]; show(cur); }
  });
  $("#g-open").addEventListener("click", () => { const u = SITES[cur](); if (u) window.NV.openUrl(u); else toast("add the weslack address first"); });
  $("#g-setup").addEventListener("submit", (e) => {
    e.preventDefault();
    let u = $("#g-wurl").value.trim(); if (!u) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
    settings.weslackUrl = u; save();
    if (frames.weslack) { frames.weslack.remove(); delete frames.weslack; }
    show("weslack");
  });

  window.NV.onGamesOpen = () => show(cur);
  if (document.querySelector("#views #page-games")) show(cur);   // restored from a previous visit
})();
