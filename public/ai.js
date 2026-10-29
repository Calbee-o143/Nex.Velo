/* Nex.AI: chat in its own tab with file uploads, screen sharing and voice chat.
   Always talks to Nex.AI, the model that runs on the Nex.Velo server (/api/ai/chat). No keys, no provider choice. Chat text stays in this browser. */
(() => {
  "use strict";
  const { esc, toast, LS } = window.NV;
  const $ = (s, r = document) => r.querySelector(s);
  const api = (p) => window.NV.api(p);

  const SYSTEM = "You are Nex.AI, a friendly, concise assistant built into the Nex.Velo web proxy. Use plain language and short answers unless asked for detail. If the user shares an image, describe and help with what you see.";
  const TEXT_EXT = /\.(txt|md|csv|json|js|ts|py|html|css|java|c|cpp|go|rs|sh|log|xml|ya?ml)$/i;
  const QUIET_MS = 90000; // if the server says nothing at all for this long, stop waiting

  let db = { cur: null, chats: [] };
  try { const old = JSON.parse(LS.get("nexvelo.ai", "{}")); db = { cur: old.cur || null, chats: old.chats || [] }; } catch {}
  let busy = false, vision = false, attachments = [], share = null, voiceOn = false, listening = null;

  const save = () => LS.set("nexvelo.ai", JSON.stringify({ cur: db.cur, chats: db.chats }));
  const chat = () => db.chats.find((c) => c.id === db.cur);

  // Nex.AI is the only AI, so the old key box and model picker are hidden
  for (const sel of ["#ai-key-btn", "#ai-key-card"]) { const el = $(sel); if (el) { el.hidden = true; el.style.display = "none"; } }
  { const m = $("#ai-model"); if (m) { m.style.display = "none"; if (m.parentElement?.tagName === "LABEL") m.parentElement.style.display = "none"; } }

  /* ---------- rendering ---------- */
  function md(t) {
    return String(t).split(/```/).map((p, i) => {
      if (i % 2) return `<pre><code>${esc(p.replace(/^[\w+-]*\n/, "").replace(/\n$/, ""))}</code></pre>`;
      return esc(p).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
    }).join("");
  }
  const prettyErr = (t) => { try { const j = JSON.parse(t); return j?.error?.message || j?.message || t; } catch { return String(t); } };

  function renderList() {
    $("#ai-list").innerHTML = db.chats.map((c) => `<button data-id="${c.id}" class="${c.id === db.cur ? "on" : ""}" title="${esc(c.title)}">${esc(c.title)}</button>`).join("");
  }
  function renderMsgs() {
    const c = chat(), box = $("#ai-msgs");
    if (!c || !c.msgs.length) {
      box.innerHTML = '<div class="aiempty"><b style="display:block;font-size:1.125rem;margin-bottom:.5rem;color:var(--fg)">nex.ai</b>ask me anything. attach text files, or press the mic to talk.</div>';
      return;
    }
    box.innerHTML = c.msgs.map((m) => `<div class="aimsg ${m.role === "user" ? "user" : "bot"}">${m.role === "user" ? esc(m.content) : md(m.content)}</div>`).join("");
    box.scrollTop = box.scrollHeight;
  }
  function newChat() {
    const c = { id: "c" + Date.now(), title: "new chat", msgs: [] };
    db.chats.unshift(c); db.cur = c.id; save(); renderList(); renderMsgs(); $("#ai-in").focus();
  }

  /* ---------- attachments + screen share ---------- */
  function shrink(src, max, q) { // src: HTMLImageElement or HTMLVideoElement
    const w = src.videoWidth || src.naturalWidth, h = src.videoHeight || src.naturalHeight;
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", q);
  }
  function renderAtt() {
    const box = $("#ai-att");
    box.hidden = !attachments.length;
    box.innerHTML = attachments.map((a, i) => `<span>${a.type === "image" ? "🖼" : "📄"} ${esc(a.name)}<button type="button" data-rm="${i}" aria-label="Remove">×</button></span>`).join("");
  }
  async function addFiles(files) {
    for (const f of files) {
      try {
        if (f.type.startsWith("image/")) {
          const url = URL.createObjectURL(f);
          const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
          attachments.push({ type: "image", name: f.name, data: shrink(img, 1280, .8) }); URL.revokeObjectURL(url);
        } else if (f.type.startsWith("text/") || TEXT_EXT.test(f.name)) {
          attachments.push({ type: "text", name: f.name, data: (await f.text()).slice(0, 30000) });
        } else toast(`${f.name}: only images and text files are supported`);
      } catch { toast(`couldn't read ${f.name}`); }
    }
    renderAtt();
  }
  async function toggleShare() {
    if (share) return stopShare();
    if (!navigator.mediaDevices?.getDisplayMedia) return toast("this device can't share its screen");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const v = $("#ai-share-v"); v.srcObject = stream; v.hidden = false; await v.play();
      share = { stream }; $("#ai-screen").classList.add("on");
      stream.getVideoTracks()[0].addEventListener("ended", stopShare);
      toast(vision ? "sharing your screen. each message includes what is on it right now." : "sharing your screen, but nex.ai can't see images yet, so only your text is sent.");
    } catch { toast("screen share was cancelled"); }
  }
  function stopShare() {
    if (!share) return;
    share.stream.getTracks().forEach((t) => t.stop()); share = null;
    const v = $("#ai-share-v"); v.srcObject = null; v.hidden = true; $("#ai-screen").classList.remove("on");
  }

  /* ---------- sending ---------- */
  async function send(text, spoken) {
    text = (text || "").trim();
    if (busy || (!text && !attachments.length)) return;

    // what the model sees
    let body = text;
    for (const a of attachments.filter((x) => x.type === "text")) body += `\n\n[file: ${a.name}]\n\`\`\`\n${a.data}\n\`\`\``;
    let images = attachments.filter((x) => x.type === "image").map((a) => a.data);
    let screenNote = "";
    if (share) {
      try { images.push(shrink($("#ai-share-v"), 1280, .7)); screenNote = "🖥 screen shared"; } catch {}
    }
    if (images.length && !vision) { // the built-in model reads text only
      toast("nex.ai can't see images or your screen yet, so I'm sending only your text.");
      images = []; screenNote = "";
      if (!body.trim()) return;
    }
    if (!chat()) newChat();
    const c = chat();
    const content = images.length
      ? [{ type: "text", text: body || "What do you see?" }, ...images.map((u) => ({ type: "image_url", image_url: { url: u } }))]
      : body;

    // what we keep (no images, to stay inside the browser's storage)
    const shown = [text, attachments.length ? "📎 " + attachments.map((a) => a.name).join(", ") : "", screenNote].filter(Boolean).join("\n");
    const history = c.msgs.map((m) => ({ role: m.role, content: m.content }));
    c.msgs.push({ role: "user", content: shown });
    if (c.title === "new chat") c.title = (text || attachments[0]?.name || "chat").slice(0, 40);
    const reply = { role: "assistant", content: "" };
    c.msgs.push(reply); attachments = []; renderAtt(); save(); renderList(); renderMsgs();

    busy = true; $("#ai-send").disabled = true;
    const bot = $("#ai-msgs").lastElementChild;
    bot.innerHTML = '<span style="opacity:.6">thinking…</span>';
    const ctl = new AbortController();
    let dog = setTimeout(() => ctl.abort(), QUIET_MS);
    const poke = () => { clearTimeout(dog); dog = setTimeout(() => ctl.abort(), QUIET_MS); };
    try {
      const r = await fetch(api("/api/ai/chat"), {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ model: "local", messages: [{ role: "system", content: SYSTEM }, ...history, { role: "user", content }] }),
      });
      if (!r.ok) {
        let d = {}; try { d = await r.json(); } catch {}
        if (r.status === 404) throw new Error("the ai needs the Nex.Velo server (the Railway site), not a static host.");
        if ([502, 503, 504].includes(r.status) && !d.error) throw new Error("the Nex.Velo server didn't answer (HTTP " + r.status + "). it may be restarting, or Nex.AI's model may have run out of memory. wait a minute and try again. if it keeps happening, open Settings and run the full check.");
        if (d.error === "vision_unavailable") throw new Error("nex.ai can't look at images or screens yet. ask again with just text.");
        throw new Error(prettyErr(d.error || "") || "nex.ai returned an error (" + r.status + ")");
      }
      poke();
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        poke();
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim(); if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            if (j.status && !reply.content) bot.innerHTML = `<span style="opacity:.6">${esc(j.status)}</span>`;
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) { reply.content += delta; bot.innerHTML = md(reply.content); $("#ai-msgs").scrollTop = $("#ai-msgs").scrollHeight; }
          } catch {}
        }
      }
      if (!reply.content) reply.content = "(no response)";
    } catch (e) {
      const net = e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(e.message || "");
      const msg = e.name === "AbortError" ? "nex.ai stopped answering (the server may be restarting). wait a moment and try again."
        : net ? "couldn't reach the Nex.Velo server. if this site is on Vercel, the api needs the newest files (the api folder and lib folder) deployed, or the Railway server running."
        : e.message || "something went wrong";
      reply.content = (reply.content ? reply.content + "\n\n" : "") + "⚠️ " + msg;
    }
    clearTimeout(dog);
    bot.innerHTML = md(reply.content);
    busy = false; $("#ai-send").disabled = false; save();
    if (voiceOn) speak(reply.content);
  }

  /* ---------- voice chat: the browser's speech recognition listens, Nex.AI answers, the browser speaks the reply ---------- */
  function speak(text) {
    const plain = text.replace(/```[\s\S]*?```/g, " (code omitted) ").replace(/[*`#_]/g, "").slice(0, 1200);
    if (!("speechSynthesis" in window) || text.startsWith("⚠️")) { if (voiceOn) setTimeout(listen, 400); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(plain);
    u.onend = () => { if (voiceOn) listen(); };
    u.onerror = () => { if (voiceOn) listen(); };
    speechSynthesis.speak(u);
  }
  function listen() {
    if (!voiceOn || busy || listening) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast("voice chat needs Chrome, Edge or Safari (this browser has no speech recognition)"); return stopVoice(); }
    const rec = new SR();
    rec.lang = navigator.language || "en-US"; rec.interimResults = true; rec.continuous = false;
    let heard = "", fatal = false;
    rec.onresult = (e) => {
      let final = "", interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) (e.results[i].isFinal ? (final += e.results[i][0].transcript) : (interim += e.results[i][0].transcript));
      if (final) heard = (heard + " " + final).trim();
      $("#ai-in").placeholder = (heard + " " + interim).trim() || "listening…";
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { fatal = true; toast("microphone access was blocked"); }
      else if (e.error === "network") { fatal = true; toast("speech recognition couldn't reach its service (the browser uses Google for it)"); }
    };
    rec.onend = () => {
      listening = null; $("#ai-in").placeholder = "ask anything";
      if (fatal) return stopVoice();
      if (!voiceOn) return;
      if (heard) send(heard, true); else setTimeout(listen, 300); // nobody spoke: listen again
    };
    listening = { stop: () => { try { rec.abort(); } catch {} } };
    $("#ai-voice").classList.add("on"); $("#ai-in").placeholder = "listening…";
    try { rec.start(); } catch { listening = null; stopVoice(); }
  }
  function toggleVoice() { voiceOn ? stopVoice() : (voiceOn = true, $("#ai-voice").classList.add("on"), listen()); }
  function stopVoice() {
    voiceOn = false; $("#ai-voice").classList.remove("on"); $("#ai-in").placeholder = "ask anything";
    if (listening) listening.stop();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  /* ---------- wiring ---------- */
  const submit = () => { const t = $("#ai-in").value; $("#ai-in").value = ""; $("#ai-in").style.height = "auto"; send(t); };
  $("#ai-form").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  // Enter sends, Shift+Enter makes a new line. beforeinput covers phone keyboards that don't report "Enter".
  $("#ai-in").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  $("#ai-in").addEventListener("beforeinput", (e) => { if ((e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") && !e.isComposing) { e.preventDefault(); submit(); } });
  $("#ai-in").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 144) + "px"; });
  $("#ai-attach").addEventListener("click", () => $("#ai-file").click());
  $("#ai-file").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
  $("#ai-att").addEventListener("click", (e) => { const b = e.target.closest("[data-rm]"); if (b) { attachments.splice(+b.dataset.rm, 1); renderAtt(); } });
  $("#ai-screen").addEventListener("click", toggleShare);
  $("#ai-voice").addEventListener("click", toggleVoice);
  $("#ai-new").addEventListener("click", newChat);
  $("#ai-list").addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (b) { db.cur = b.dataset.id; save(); renderList(); renderMsgs(); } });

  async function onOpen() {
    renderList(); renderMsgs();
    // also tells the server to start loading Nex.AI right now, so the first answer is quicker
    try { const s = await (await fetch(api("/api/ai/status?wake=1"))).json(); vision = !!s.vision; } catch { vision = false; }
  }
  window.NV.onAiOpen = onOpen;
  if (document.querySelector("#views #page-ai")) onOpen(); // restored from a previous visit
  window.NV.loaded.ai = true;
})();
