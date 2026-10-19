// Copies Scramjet, bare-mux and libcurl files into public/ so a static host (Vercel) can serve them.
import { cpSync, rmSync } from "node:fs";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

for (const [src, dest] of [[scramjetPath, "scram"], [libcurlPath, "libcurl"], [baremuxPath, "baremux"]]) {
  rmSync(`public/${dest}`, { recursive: true, force: true });
  cpSync(src, `public/${dest}`, { recursive: true });
}
console.log("Assets copied to public/");
