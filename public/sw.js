/* Service worker: Scramjet routing + AdBlock */
importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

const PREFIX = "/scramjet/"; // must match the controller prefix in index.html
const SETTINGS_CACHE = "nexus-settings";
const SETTINGS_KEY = "/__adblock";

/* ---------- AdBlock ---------- */
const BLOCKED_DOMAINS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com",
  "googletagmanager.com", "googletagservices.com", "adservice.google.com", "pagead2.googlesyndication.com",
  "adnxs.com", "adsrvr.org", "advertising.com", "adform.net", "criteo.com", "criteo.net",
  "taboola.com", "outbrain.com", "revcontent.com", "mgid.com", "zemanta.com",
  "pubmatic.com", "rubiconproject.com", "openx.net", "casalemedia.com", "indexww.com",
  "amazon-adsystem.com", "media.net", "moatads.com", "scorecardresearch.com", "quantserve.com",
  "adsafeprotected.com", "serving-sys.com", "smartadserver.com", "teads.tv", "sharethrough.com",
  "33across.com", "bidswitch.net", "contextweb.com", "lijit.com", "sovrn.com",
  "hotjar.com", "mouseflow.com", "fullstory.com", "crazyegg.com", "mxpnl.com",
  "facebook.net", "connect.facebook.net", "ads.twitter.com", "static.ads-twitter.com",
  "ads.linkedin.com", "analytics.tiktok.com", "ads.yahoo.com", "adsymptotic.com",
  "popads.net", "propellerads.com", "exoclick.com", "juicyads.com", "trafficjunky.com",
  "adcolony.com", "applovin.com", "unity3d.com/ads", "chartboost.com", "inmobi.com",
  "yandex.ru/ads", "an.yandex.ru", "mc.yandex.ru", "adriver.ru",
];
const BLOCKED_PATTERNS = [
  /\/ads?\/[^/]*\.(js|gif|png|jpg|html)/i,
  /\/(adserver|adsense|adframe|advert|banner_ads|pagead|prebid)\b/i,
  /[?&](ad_unit|adunit|ad_slot)=/i,
  /\/(analytics|gtag|gtm|fbevents)\.js(\?|$)/i,
];

function hostBlocked(host) {
  return BLOCKED_DOMAINS.some((d) => {
    if (d.includes("/")) return false;
    return host === d || host.endsWith("." + d);
  });
}

function decodeTarget(requestUrl) {
  try {
    const u = new URL(requestUrl);
    const raw = u.href.slice(u.origin.length + PREFIX.length);
    return new URL(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function shouldBlock(request) {
  // Never block the page the person is actually navigating to
  if (request.mode === "navigate" && request.destination === "document") return false;
  const target = decodeTarget(request.url);
  if (!target) return false;
  if (hostBlocked(target.hostname)) return true;
  return BLOCKED_PATTERNS.some((re) => re.test(target.pathname + target.search));
}

function emptyResponse(destination) {
  switch (destination) {
    case "script":
      return new Response("/* blocked */", { status: 200, headers: { "content-type": "application/javascript" } });
    case "style":
      return new Response("", { status: 200, headers: { "content-type": "text/css" } });
    case "iframe":
    case "frame":
      return new Response("<!doctype html><title>blocked</title>", { status: 200, headers: { "content-type": "text/html" } });
    default:
      return new Response(null, { status: 204 });
  }
}

/* ---------- Settings (persist across worker restarts) ---------- */
let adblockEnabled = true;
const settingsReady = (async () => {
  try {
    const cache = await caches.open(SETTINGS_CACHE);
    const hit = await cache.match(SETTINGS_KEY);
    if (hit) adblockEnabled = (await hit.json()).enabled !== false;
  } catch {}
})();

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "adblock") {
    adblockEnabled = !!data.enabled;
    event.waitUntil(
      caches.open(SETTINGS_CACHE).then((c) =>
        c.put(SETTINGS_KEY, new Response(JSON.stringify({ enabled: adblockEnabled })))
      )
    );
  }
});

/* ---------- Fetch ---------- */
async function handleRequest(event) {
  // Only touch Scramjet for proxied URLs. Opening its database from the worker before the page
  // has created it leaves an empty database behind, which is what caused the IndexedDB error.
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(PREFIX)) return fetch(event.request);

  await settingsReady;
  let configured = true;
  try { await scramjet.loadConfig(); } catch (e) { configured = false; }

  if (configured && scramjet.route(event)) {
    if (adblockEnabled && shouldBlock(event.request)) {
      return emptyResponse(event.request.destination);
    }
    return scramjet.fetch(event);
  }
  return fetch(event.request);
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});
