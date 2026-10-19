// Copies Scramjet, bare-mux and libcurl browser files into public/ so they can be served.
// Finds each folder by looking for a known file, so it doesn't depend on a package's export names.
import { cpSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, sep } from "node:path";

const base = join("node_modules", "@mercuryworkshop");

function findDir(pkg, marker) {
  const root = join(base, pkg);
  if (!existsSync(root)) throw new Error(`${pkg} is not installed`);
  const all = readdirSync(root, { recursive: true }).filter((p) => !p.split(sep).includes("node_modules"));
  const hits = all.filter((p) => p === marker || p.endsWith(sep + marker)).sort((a, b) => a.length - b.length);
  if (!hits.length) {
    console.error(`Could not find ${marker} in ${pkg}. Files present:\n` + all.slice(0, 80).join("\n"));
    throw new Error(`${marker} not found in ${pkg}`);
  }
  const dir = join(root, dirname(hits[0]));
  console.log(`${pkg}: using ${dir}`);
  return dir;
}

const jobs = [
  ["scramjet", "scramjet.all.js", "scram"],
  ["libcurl-transport", "index.mjs", "libcurl"],
  ["bare-mux", "worker.js", "baremux"],
];

for (const [pkg, marker, dest] of jobs) {
  const src = findDir(pkg, marker);
  rmSync(join("public", dest), { recursive: true, force: true });
  cpSync(src, join("public", dest), { recursive: true });
}
console.log("Assets copied to public/");

// Print installed versions so mismatches are easy to spot in the build log
for (const pkg of ["scramjet", "libcurl-transport", "bare-mux", "wisp-js"]) {
  try {
    const v = JSON.parse(readFileSync(join(base, pkg, "package.json"), "utf8")).version;
    console.log(`version ${pkg}@${v}`);
  } catch {}
}
