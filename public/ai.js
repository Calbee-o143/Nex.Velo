/* Nex.AI: chat in its own tab with file uploads, screen sharing and voice chat.
   Talks to /api/ai/chat and /api/ai/transcribe (Groq). Chat text stays in this browser. */
(() => {
  "use strict";
  const { esc, toast, LS } = window.NV;
  const $ = (s, r = document) => r.querySelector(s);
  const SYSTEM = "You are Nex.AI, a friendly, concise assistant built into the Nex.Velo web proxy. Use plain language and short answers unless asked for detail. If the user shares their screen or an image, describe and help with what you see.";
  const TEXT_EXT = /\.(txt|md|csv|json|js|ts|py|html|css|java|c|cpp|go|rs|sh|log|xml|ya?ml)$/i;
  let db = { cur: null, model: "openai/gpt-oss-20b", chats: [] };
  try { db = { ...db, ...JSON.parse(LS.get("nexvelo.ai", "{}")) }; } catch {}
  let busy = false, serverKey = null, attachments = [], share = null, voiceOn = false, listening = null;
  const save = () => LS.set("nexvelo.ai", JSON.stringify(db));
  const chat = () => db.chats.find((c) => c.id === db.cur);
  const getKey = () => LS.get("nexvelo.aikey", "");
  const authHeaders = (h = {}) => (getKey() ? { ...h, "x-groq-key": getKey() } : h);

  /* ---------- rendering ---------- */
  function md(t) {
    return String(t).split(/```/).map((p, i) => {
      if (i % 2) return `<pre><code>${esc(p.replace(/^[\w+-]*\n/, "").replace(/\n$/, ""))}</code></pre>`;
      return esc(p).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
    }).join("");
  }
  function renderList() {
    $("#ai-list").innerHTML = db.chats.map((c) => `<button data-id="${c.id}" class="${c.id === db.cur ? "on" : ""}" title="${esc(c.title)}">${esc(c.title)}</button>`).join("");
  }
  function renderMsgs() {
    const c = chat(), box = $("#ai-msgs");
    if (!c || !c.msgs.length) {
      box.innerHTML = '<div class="aiempty"><b style="display:block;font-size:1.125rem;margin-bottom:.5rem;color:var(--fg)">nex.ai</b>ask me anything. attach files or images, share your screen, or press the mic to talk.</div>';
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
  function shrink(src, max, q) {   // src: HTMLImageElement or HTMLVideoElement
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
      toast("sharing your screen. each message includes what is on it right now.");
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
    if (!chat()) newChat();
    const c = chat();
    // what the model sees
    let body = text;
    for (const a of attachments.filter((x) => x.type === "text")) body += `\n\n[file: ${a.name}]\n\`\`\`\n${a.data}\n\`\`\``;
    const images = attachments.filter((x) => x.type === "image").map((a) => a.data);
    let screenNote = "";
    if (share) {
      try { images.push(shrink($("#ai-share-v"), 1280, .7)); screenNote = "🖥 screen shared"; } catch {}
    }
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
    try {
      const r = await fetch("/api/ai/chat", {
        method: "POST", headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ model: db.model, messages: [{ role: "system", content: SYSTEM }, ...history, { role: "user", content }] }),
      });
      if (!r.ok) {
        let d = {}; try { d = await r.json(); } catch {}
        if (r.status === 404) throw new Error("the ai needs the Nex.Velo server (the Railway site), not a static host.");
        if (d.error === "no_key" || r.status === 401) throw new Error("no api key yet. press the api key button (top right) and paste a free Groq key, or set GROQ_API_KEY on the server.");
        throw new Error(d.error || "the ai service returned an error (" + r.status + ")");
      }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim(); if (data === "[DONE]") continue;
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta?.content;
            if (delta) { reply.content += delta; bot.innerHTML = md(reply.content); $("#ai-msgs").scrollTop = $("#ai-msgs").scrollHeight; }
          } catch {}
        }
      }
      if (!reply.content) reply.content = "(no response)";
    } catch (e) { reply.content = "⚠️ " + (e.message || "something went wrong"); }
    bot.innerHTML = md(reply.content);
    busy = false; $("#ai-send").disabled = false; save();
    if (voiceOn) speak(reply.content); 
  }

  /* ---------- voice chat: record, transcribe on the server, speak the reply ---------- */
  function speak(text) {
    const plain = text.replace(/```[\s\S]*?```/g, " (code omitted) ").replace(/[*`#_]/g, "").slice(0, 1200);
    if (!("speechSynthesis" in window) || text.startsWith("⚠️")) { if (voiceOn) listen(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(plain);
    u.onend = () => { if (voiceOn) listen(); };
    u.onerror = () => { if (voiceOn) listen(); };
    speechSynthesis.speak(u);
  }
  async function listen() {
    if (!voiceOn || busy || listening) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast("voice chat isn't supported on this browser"); return stopVoice(); }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast("microphone access was blocked"); return stopVoice(); }
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const chunks = []; let skip = false;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    let started = false, lastLoud = Date.now(); const t0 = Date.now();
    const timer = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
      const now = Date.now();
      if (Math.sqrt(sum / buf.length) > 0.03) { started = true; lastLoud = now; }
      if (started && now - lastLoud > 1300) rec.stop();                 // finished talking
      else if (!started && now - t0 > 12000) { skip = true; rec.stop(); } // nobody spoke, try again
      else if (now - t0 > 45000) rec.stop();
    }, 100);
    listening = { rec, stop: () => { skip = true; try { rec.stop(); } catch {} } };
    $("#ai-voice").classList.add("on"); $("#ai-in").placeholder = "listening…";
    rec.onstop = async () => {
      clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => {}); listening = null;
      $("#ai-in").placeholder = "ask anything";
      if (!voiceOn) return;
      if (skip) return listen();
      $("#ai-in").placeholder = "transcribing…";
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const r = await fetch("/api/ai/transcribe", { method: "POST", headers: authHeaders({ "content-type": blob.type }), body: blob });
        const d = await r.json().catch(() => ({}));
        $("#ai-in").placeholder = "ask anything";
        if (!r.ok) { toast(d.error === "no_key" ? "voice chat needs a Groq api key (see the api key button)" : d.error || "couldn't hear that"); return stopVoice(); }
        if (d.text) send(d.text, true); else listen();
      } catch { $("#ai-in").placeholder = "ask anything"; toast("couldn't reach the server for voice"); stopVoice(); }
    };
    rec.start();
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
  $("#ai-model").addEventListener("change", (e) => { db.model = e.target.value; save(); });
  $("#ai-key-btn").addEventListener("click", () => {
    const note = serverKey ? "The server already has a key, so this is optional.\n\n" : "";
    const k = prompt(note + "Paste your Groq API key. It is stored only in this browser and sent to this site's server for each message. Leave empty to remove it.", getKey());
    if (k === null) return;
    if (k.trim()) { LS.set("nexvelo.aikey", k.trim()); toast("api key saved"); } else { LS.del("nexvelo.aikey"); toast("api key removed"); }
  });

  async function onOpen() {
    $("#ai-model").value = db.model; renderList(); renderMsgs();
    if (serverKey === null) { try { serverKey = (await (await fetch("/api/ai/status")).json()).serverKey; } catch { serverKey = false; } }
  }
  window.NV.onAiOpen = onOpen;
  if (document.querySelector("#views #page-ai")) onOpen();   // restored from a previous visit
  window.NV.loaded.ai = true;
})();
