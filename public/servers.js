/* Servers page: keep a list of Wisp servers, test their speed, pick one, or let it pick the fastest. */
(() => {
  "use strict";
  const { esc, toast, LS, settings, defaultWisp, testWisp, normalizeWisp } = window.NV;
  const $ = (s, r = document) => r.querySelector(s);
  let list = []; try { list = JSON.parse(LS.get("nexvelo.servers", "[]")) || []; } catch {}
  const speed = {};   // url -> text
  const ms = {};      // url -> number
  const persist = () => LS.set("nexvelo.servers", JSON.stringify(list));
  const all = () => [{ url: defaultWisp, label: "this site (built in)" }, ...list.map((u) => ({ url: u, label: u }))];

  function render() {
    $("#sv-list").innerHTML =
      `<div class="row" style="margin-bottom:.75rem"><button class="btn" id="sv-best">test all and use the fastest</button></div>` +
      all().map((s) => {
        const on = settings.wisp === s.url;
        return `<div class="sv-row${on ? " on" : ""}" data-u="${esc(s.url)}"><b>${esc(s.label)}</b><small>${esc(speed[s.url] || "")}</small>` +
          `<button class="btn" data-a="test">test</button><button class="btn${on ? "" : " primary"}" data-a="use"${on ? " disabled" : ""}>${on ? "in use" : "use"}</button>` +
          (s.url === defaultWisp ? "" : '<button class="btn danger" data-a="rm">remove</button>') + "</div>";
      }).join("");
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

  $("#sv-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const url = normalizeWisp($("#sv-url").value); if (!url) return;
    if (url === defaultWisp || list.includes(url)) toast("that server is already in the list");
    else { list.push(url); persist(); }
    $("#sv-url").value = ""; render(); test(url);
  });
  $("#sv-list").addEventListener("click", async (e) => {
    if (e.target.closest("#sv-best")) {
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
  window.NV.onServersOpen = render;
  if (document.querySelector("#views #page-servers")) render();   // restored from a previous visit
})();
