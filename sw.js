const VERSION = 'ss-v1.0.0';
const MUSIC_CACHE = 'ss-music-1';   // kept across versions so songs aren't re-downloaded on every update
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'songs.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'covers/keep-the-beat.jpg', 'covers/abundance.jpg', 'covers/light-goes-dark.jpg', 'covers/under-the-rain.jpg', 'covers/arcadius-fury.jpg', 'covers/breaking-through.jpg', 'covers/viking-hardcore-motivational-remastered.jpg', 'covers/shogunai.jpg', 'covers/viking.jpg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== MUSIC_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// songs: downloaded once in the background the first time they're requested, then served from cache with Range support (Safari needs 206s)
const inflight = {};
function cacheSong(url) {
  if (!inflight[url]) inflight[url] = fetch(url, { cache: 'no-cache' }).then(r => r.status === 200 ? caches.open(MUSIC_CACHE).then(c => c.put(url, r)) : null).catch(() => {}).then(() => { delete inflight[url]; });
  return inflight[url];
}
async function songResponse(e, url) {
  const hit = await caches.open(MUSIC_CACHE).then(c => c.match(url));
  if (!hit) { e.waitUntil(cacheSong(url)); const r = await fetch(e.request); return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers }); }   // re-wrapped so every range the player gets has the same (synthetic) origin; Chrome errors when cached and network ranges mix
  const range = e.request.headers.get('range'); if (!range) return hit;
  const blob = await hit.blob(), size = blob.size, m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  let s = m[1] ? +m[1] : 0, end = m[2] ? Math.min(+m[2], size - 1) : size - 1; if (!m[1] && m[2]) { s = Math.max(0, size - +m[2]); end = size - 1; }
  if (s >= size) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(s, end + 1), { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': `bytes ${s}-${end}/${size}`, 'Content-Length': String(end - s + 1), 'Accept-Ranges': 'bytes' } });
}
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url); if (req.method !== 'GET' || u.origin !== location.origin) return;
  if (/\/songs\/[^/]+\.(mp3|m4a|wav|aac|ogg)$/i.test(u.pathname)) { e.respondWith(songResponse(e, u.origin + u.pathname).catch(() => new Response('', { status: 504 }))); return; }
  // network first so updates show up; cache fallback when offline
  e.respondWith(fetch(req).then(res => { if (res.ok && res.status === 200) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {}); } return res; })
    .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
