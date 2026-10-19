import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const publicPath = fileURLToPath(new URL("./public/", import.meta.url));

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  dns_servers: ["1.1.1.3", "1.0.0.3"],
});

const app = Fastify({
  logger: false,
  serverFactory: (handler) =>
    createServer(handler).on("upgrade", (req, socket, head) => {
      if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
      else socket.destroy();
    }),
});

app.register(fastifyStatic, {
  root: publicPath,
  setHeaders(res, path) {
    if (path.endsWith("sw.js")) res.setHeader("Cache-Control", "no-cache");
  },
});
app.register(fastifyStatic, { root: scramjetPath, prefix: "/scram/", decorateReply: false });
app.register(fastifyStatic, { root: libcurlPath, prefix: "/libcurl/", decorateReply: false });
app.register(fastifyStatic, { root: baremuxPath, prefix: "/baremux/", decorateReply: false });

const port = Number(process.env.PORT) || 8080;
app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log(`Nexus proxy running on http://localhost:${port}`);
});
