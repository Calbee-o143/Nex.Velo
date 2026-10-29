// Nex.AI's model runs in this separate process (started by lib/api.js).
// If the model crashes or the server runs out of memory, only this process dies. The Nex.Velo proxy keeps running and shows a clear message.

const send = (m) => { try { process.send(m); } catch {} };
const stops = new Map();
let T = null, gen = null;
const rssMB = () => Math.round(process.memoryUsage().rss / 1e6);

const fatal = (e) => { send({ type: "fatal", error: String(e?.stack || e).slice(0, 600) }); setTimeout(() => process.exit(1), 100); };
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

async function load({ models, hosts }) {
  // The model files are public, so no login is needed. A wrong or expired HF_TOKEN makes Hugging Face answer "Unauthorized", so it is ignored.
  // (To use a token on purpose, set NEXAI_HF_TOKEN.)
  delete process.env.HF_TOKEN; delete process.env.HF_ACCESS_TOKEN;
  if (process.env.NEXAI_HF_TOKEN) process.env.HF_TOKEN = process.env.NEXAI_HF_TOKEN;

  const name = "@huggingface/" + "transformers";
  try { T = await import(name); }
  catch (e) { throw new Error("the model runtime (@huggingface/transformers) isn't installed on this server: " + String(e?.message || e).slice(0, 160)); }
  T.env.cacheDir = process.env.NEXAI_CACHE || "/tmp/nexai";
  T.env.allowLocalModels = false;

  const lean = { enableCpuMemArena: false, enableMemPattern: false, intraOpNumThreads: 2 }; // less memory, a little slower
  const progress_callback = (p) => { if (p && p.status === "progress" && typeof p.progress === "number") send({ type: "progress", value: Math.round(p.progress) + "%" }); };
  const attempts = [];
  for (const host of hosts) {
    T.env.remoteHost = host.replace(/\/?$/, "/");
    const tag = new URL(host).hostname;
    for (const id of models) {
      for (const [dtype, session_options] of [["q4", lean], ["q4", undefined], ["q8", lean]]) {
        try {
          gen = await T.pipeline("text-generation", id, { dtype, session_options, progress_callback });
          return id;
        } catch (e) {
          const msg = String(e?.message || e).replace(/\s+/g, " ");
          attempts.push(tag + " " + id.split("/").pop() + "/" + dtype + (session_options ? "+lean" : "") + ": " + msg.slice(0, 150));
          console.warn("[nex.ai] failed:", attempts[attempts.length - 1]);
          if (/unauthori[sz]ed|forbidden|\b40[13]\b/i.test(msg)) break; // the other formats of this same model would be refused too
        }
      }
    }
  }
  throw new Error("Nex.AI's model couldn't be downloaded or started. what went wrong: " + attempts.join(" | ").slice(0, 700) +
    (attempts.length && attempts.every((a) => /unauthori[sz]ed|forbidden/i.test(a)) ? " (Hugging Face also answers 'unauthorized' when a model name doesn't exist. check NEXAI_MODEL if you set it)" : ""));
}

process.on("message", async (m) => {
  if (m.type === "load") {
    try { const model = await load(m); console.log("[nex.ai] model ready:", model, rssMB() + " MB"); send({ type: "ready", model, rssMB: rssMB() }); }
    catch (e) { send({ type: "loaderror", error: String(e?.message || e) }); }
  } else if (m.type === "chat") {
    const { rid } = m;
    try {
      const stop = new T.InterruptableStoppingCriteria(); stops.set(rid, stop);
      const streamer = new T.TextStreamer(gen.tokenizer, { skip_prompt: true, skip_special_tokens: true, callback_function: (text) => send({ type: "token", rid, text }) });
      await gen(m.messages, { max_new_tokens: m.max_new_tokens || 450, do_sample: true, temperature: 0.7, top_p: 0.9, repetition_penalty: 1.1, streamer, stopping_criteria: stop });
      send({ type: "done", rid, rssMB: rssMB() });
    } catch (e) { send({ type: "chaterror", rid, error: String(e?.message || e).slice(0, 300) }); }
    finally { stops.delete(rid); }
  } else if (m.type === "stop") {
    try { stops.get(m.rid)?.interrupt(); } catch {}
  }
});

send({ type: "hello" });
