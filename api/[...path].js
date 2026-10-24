// Runs the Nex.Velo API (AI, music, lyrics, bookmarks icons...) as a Vercel function, so those features work
// from the same address as the site and don't depend on another server being up.
// The proxy's Wisp connection still needs a real WebSocket server (Railway or similar).
import Fastify from "fastify";
import { registerApi } from "../lib/api.js";

const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
registerApi(app);

export default async function handler(req, res) {
  await app.ready();
  app.server.emit("request", req, res);
}
