import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { registerApi } from "./lib/api.js";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const publicPath = fileURLToPath(new URL("./public/", import.meta.url));

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  dns_servers: ["1.1.1.3", "1.0.0.3"],
});

const app = Fastify({
  logger: false,
  bodyLimit: 14 * 1024 * 1024,
  serverFactory: (handler) =>
    createServer(handler).on("upgrade", (req, socket, head) => {
      if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
      else socket.destroy();
    }),
});

registerApi(app);

/* ================= Static site ================= */
app.register(fastifyStatic, { root: publicPath });
app.addHook("onSend", async (req, reply, payload) => {
  const p = req.url.split("?")[0];
  if (p === "/" || p === "/index.html" || p === "/sw.js" || p === "/version.json") reply.header("Cache-Control", "no-cache");
  return payload;
});

const port = Number(process.env.PORT) || 8080;
app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log(`Nex.Velo running on http://localhost:${port}`);
});
