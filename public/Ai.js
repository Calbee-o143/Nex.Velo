/* Nex.AI: chat in its own tab. Talks to /api/ai/chat (Groq, OpenAI GPT OSS models). Chats stay in this browser. */
(() => {
  "use strict";
  const { esc, toast, LS } = window.NV;
  const $ = (s, r = document) => r.querySelector(s);
  const SYSTEM = "You are Nex.AI, a friendly, concise assistant built into the Nex.Velo web proxy. Use plain language and short answers unless asked for detail.";
  let db = { cur: null, model: "openai/gpt-oss-20b", chats: [] };
  try { db = { ...db, ...JSON.parse(LS.get("nexvelo.ai", "{}")) }; } catch {}
  let busy = false, serverKey = null;
  const save = () => LS.set("nexvelo.ai", JSON.stringify(db));
  const chat = () => db.chats.find((c) => c.id === db.cur);
  const getKey = () => LS.get("nexvelo.aikey", "");

  // tiny markdown: code blocks, inline code, bold, line breaks (everything escaped first)
  function md(t) {
    const parts = String(t).split(/```/);
    return parts.map((p, i) => {
      if (i % 2) { const body = p.replace(/^[\w+-]*\n/, ""); return `<pre><code>${esc(body.replace(/\n$/, ""))}</code></pre>`; }
      return esc(p).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
    }).join("");
  }

  function renderList() {
    $("#ai-list").innerHTML = db.chats.map((c) => `<button data-id="${c.id}" class="${c.id === db.cur ? "on" : ""}" title="${esc(c.title)}">${esc(c.title)}</button>`).join("");
  }
  function renderMsgs() {
    const c = chat(), box = $("#ai-msgs");
    if (!c || !c.msgs.length) {
      box.innerHTML = '<div class="aiempty"><b style="display:block;font-size:1.125rem;margin-bottom:.5rem;color:var(--fg)">nex.ai</b>ask me anything. i can explain things, help with homework, write, or fix code.</div>';
      return;
    }
    box.innerHTML = c.msgs.map((m) => `<div class="aimsg ${m.role === "user" ? "user" : "bot"}">${m.role === "user" ? esc(m.content) : md(m.content)}</div>`).join("");
    box.scrollTop = box.scrollHeight;
  }
  function newChat() {
    const c = { id: "c" + Date.now(), title: "new chat", msgs: [] };
    db.chats.unshift(c); db.cur = c.id; save(); renderList(); renderMsgs(); $("#ai-in").focus();
  }

  async function send(text) {
    if (busy || !text.trim()) return;
    if (!chat()) newChat();
    const c = chat();
    c.msgs.push({ role: "user", content: text.trim() });
    if (c.title === "new chat") c.title = text.trim().slice(0, 40);
    const reply = { role: "assistant", content: "" };
    c.msgs.push(reply); save(); renderList(); renderMsgs();
    busy = true; $("#ai-send").disabled = true;
    const bot = $("#ai-msgs").lastElementChild;
    try {
      const headers = { "content-type": "application/json" };
      if (getKey()) headers["x-groq-key"] = getKey();
      const r = await fetch("/api/ai/chat", {
        method: "POST", headers,
        body: JSON.stringify({ model: db.model, messages: [{ role: "system", content: SYSTEM }, ...c.msgs.slice(0, -1)] }),
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
    } catch (e) {
      reply.content = "⚠️ " + (e.message || "something went wrong");
    }
    bot.innerHTML = md(reply.content);
    busy = false; $("#ai-send").disabled = false; save();
  }

  $("#ai-form").addEventListener("submit", (e) => { e.preventDefault(); const t = $("#ai-in").value; $("#ai-in").value = ""; $("#ai-in").style.height = "auto"; send(t); });
  $("#ai-in").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#ai-form").requestSubmit(); } });
  $("#ai-in").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 144) + "px"; });
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
  // restored from a previous visit
  if (document.querySelector("#views #page-ai")) onOpen();
})();
