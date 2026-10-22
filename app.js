// SoundStack: a 3D cover-stack music player for your own Suno songs. Plain JS, no build step.
(() => {
'use strict';
const $ = s => document.querySelector(s);
const au = $('#au'), stage = $('#stage'), stackEl = $('#stack'), wave = $('#wave'), wctx = wave.getContext('2d');
const LS = 'ss-state-v1', VISIBLE = 16;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = t => { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

// ---------- state ----------
let st = { favs: [], shuffle: false, repeat: 'all', favOnly: false, last: null };
try { Object.assign(st, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) {}
const save = () => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch (e) {} };
let lib = [];          // all songs: {id, title, artist, style, cover, color, duration, peaks, url, user, pending}
let queue = [];        // indices into lib in play order (filtered by favorites)
let pos = 0;           // unbounded position; front song = queue[mod(pos)]
let busy = false, picking = false, userPaused = true;
const mod = (v, n) => ((v % n) + n) % n;
const cur = () => queue.length ? lib[queue[mod(pos, queue.length)]] : null;

// ---------- ID3v2 reader (title, artist, genre, embedded cover) ----------
function dec(bytes, enc) {
  try {
    if (enc === 0) return new TextDecoder('latin1').decode(bytes);
    if (enc === 1) return new TextDecoder('utf-16').decode(bytes);
    if (enc === 2) return new TextDecoder('utf-16be').decode(bytes);
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) { return ''; }
}
const clean = s => (s || '').replace(/\0+$/g, '').split('\0')[0].trim();
function termLen(b, i, enc) {   // index just past the null terminator for this encoding
  if (enc === 1 || enc === 2) { while (i + 1 < b.length && !(b[i] === 0 && b[i + 1] === 0)) i += 2; return i + 2; }
  while (i < b.length && b[i] !== 0) i++; return i + 1;
}
function unsync(b) { const o = []; for (let i = 0; i < b.length; i++) { o.push(b[i]); if (b[i] === 0xff && b[i + 1] === 0) i++; } return new Uint8Array(o); }
async function readID3(blob) {
  const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
  const ver = head[3], flags = head[5];
  const size = (head[6] & 127) << 21 | (head[7] & 127) << 14 | (head[8] & 127) << 7 | (head[9] & 127);
  let b = new Uint8Array(await blob.slice(10, 10 + size).arrayBuffer());
  if (flags & 0x80 && ver < 4) b = unsync(b);
  let i = 0; const out = {};
  if (flags & 0x40) { const n = ver === 4 ? ((b[0] & 127) << 21 | (b[1] & 127) << 14 | (b[2] & 127) << 7 | (b[3] & 127)) : (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) + 4; i = n; }
  const idLen = ver === 2 ? 3 : 4, hLen = ver === 2 ? 6 : 10;
  while (i + hLen <= b.length) {
    const id = String.fromCharCode(...b.slice(i, i + idLen));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let fs = ver === 2 ? (b[i + 3] << 16 | b[i + 4] << 8 | b[i + 5]) : ver === 4 ? ((b[i + 4] & 127) << 21 | (b[i + 5] & 127) << 14 | (b[i + 6] & 127) << 7 | (b[i + 7] & 127)) : (b[i + 4] << 24 | b[i + 5] << 16 | b[i + 6] << 8 | b[i + 7]) >>> 0;
    const fflags = ver === 4 ? b[i + 9] : 0;
    let f = b.slice(i + hLen, i + hLen + fs); i += hLen + fs;
    if (!fs) continue;
    if (fflags & 0x02) f = unsync(f);
    if (fflags & 0x01) f = f.slice(4);   // data length indicator
    const enc = f[0];
    if (/^(TIT2|TT2)$/.test(id)) out.title = clean(dec(f.slice(1), enc));
    else if (/^(TPE1|TP1)$/.test(id)) out.artist = clean(dec(f.slice(1), enc));
    else if (/^(TCON|TCO)$/.test(id)) out.genre = clean(dec(f.slice(1), enc)).replace(/^\(\d+\)/, '');
    else if ((id === 'APIC' || id === 'PIC') && !out.picture) {
      let j = 1, mime;
      if (id === 'PIC') { const fmt3 = String.fromCharCode(...f.slice(1, 4)).toLowerCase(); mime = fmt3 === 'png' ? 'image/png' : 'image/jpeg'; j = 4; }
      else { let k = j; while (k < f.length && f[k] !== 0) k++; mime = dec(f.slice(j, k), 0) || 'image/jpeg'; j = k + 1; }
      j += 1;                 // picture type
      j = termLen(f, j, enc); // description
      const data = f.slice(j);
      if (data.length > 100) { if (!/image\//.test(mime)) mime = data[0] === 0x89 ? 'image/png' : 'image/jpeg'; out.picture = new Blob([data], { type: mime }); }
    }
  }
  return out;
}

// ---------- colors + generated covers ----------
async function dominantColor(src) {
  try {
    const img = await loadImg(src), c = document.createElement('canvas'); c.width = c.height = 40;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, 40, 40);
    const d = x.getImageData(0, 0, 40, 40).data, bins = Array.from({ length: 24 }, () => [0, 0, 0, 0]);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx, s = mx ? (mx - mn) / mx : 0;
      if (s < .22 || v < .18) continue;
      let h = mx === mn ? 0 : mx === r ? (g - b) / (mx - mn) : mx === g ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn); h = mod(h / 6, 1);
      const bin = bins[Math.floor(h * 24) % 24], w = s * v * (.3 + v); bin[0] += r * w; bin[1] += g * w; bin[2] += b * w; bin[3] += w;
    }
    const best = bins.reduce((a, b) => b[3] > a[3] ? b : a);
    if (best[3] < .5) return '#7a7f99';
    let [r, g, b] = best.slice(0, 3).map(v => v / best[3]);
    const mx = Math.max(r, g, b), k = clamp(mx, .45, .85) / (mx || 1); [r, g, b] = [r, g, b].map(v => Math.round(clamp(v * k, 0, 1) * 255));
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  } catch (e) { return '#6a5cff'; }
}
function loadImg(src) { return new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; }); }
function genCover(title) {   // only for songs with no embedded art
  const h = hash(title), h1 = h % 360, h2 = (h1 + 40 + (h >> 9) % 120) % 360, c = document.createElement('canvas'); c.width = c.height = 600;
  const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 600, 600);
  g.addColorStop(0, `hsl(${h1} 75% 52%)`); g.addColorStop(1, `hsl(${h2} 70% 22%)`); x.fillStyle = g; x.fillRect(0, 0, 600, 600);
  for (let i = 0; i < 7; i++) { const r = 80 + ((h >> i) % 200); x.globalAlpha = .18; x.fillStyle = `hsl(${(h1 + i * 30) % 360} 90% 70%)`; x.beginPath(); x.arc((h >> (i * 3)) % 600, (h >> (i * 2 + 1)) % 600, r, 0, 7); x.fill(); }
  x.globalAlpha = .5; x.strokeStyle = '#fff'; x.lineWidth = 3;
  for (let k = 0; k < 5; k++) { x.beginPath(); for (let px = 0; px <= 600; px += 10) x.lineTo(px, 380 + k * 22 + Math.sin(px / 40 + k + h % 7) * (18 - k * 3)); x.stroke(); }
  x.globalAlpha = 1; x.fillStyle = '#fff'; x.font = '700 46px -apple-system, Segoe UI, Roboto, sans-serif'; x.textBaseline = 'bottom';
  const words = title.split(/\s+/), lines = []; let line = '';
  for (const w of words) { if (x.measureText(line + ' ' + w).width > 520 && line) { lines.push(line); line = w; } else line = (line ? line + ' ' : '') + w; }
  lines.push(line); lines.slice(-3).reverse().forEach((l, i) => x.fillText(l, 40, 560 - i * 54));
  return new Promise(ok => c.toBlob(ok, 'image/jpeg', .88));
}

// ---------- IndexedDB for songs added from the phone ----------
const idb = { db: null };
function dbOpen() {
  if (idb.db) return Promise.resolve(idb.db);
  return new Promise((ok, no) => { const r = indexedDB.open('soundstack', 1); r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'id' }); r.onsuccess = () => ok(idb.db = r.result); r.onerror = () => no(r.error); });
}
async function dbAll() { const db = await dbOpen(); return new Promise((ok, no) => { const r = db.transaction('songs').objectStore('songs').getAll(); r.onsuccess = () => ok(r.result || []); r.onerror = () => no(r.error); }); }
async function dbPut(v) { const db = await dbOpen(); return new Promise((ok, no) => { const t = db.transaction('songs', 'readwrite'); t.objectStore('songs').put(v); t.oncomplete = ok; t.onerror = () => no(t.error); }); }
async function dbDel(id) { const db = await dbOpen(); return new Promise((ok, no) => { const t = db.transaction('songs', 'readwrite'); t.objectStore('songs').delete(id); t.oncomplete = ok; t.onerror = () => no(t.error); }); }

function fromRecord(r) {
  return { id: r.id, title: r.title, artist: r.artist || 'Odisus', style: r.style || 'Added from phone', color: r.color, duration: r.duration, peaks: r.peaks,
    url: URL.createObjectURL(r.blob), cover: URL.createObjectURL(r.cover), user: true, record: r };
}

async function peaksFor(blob) {   // decode at a low sample rate to keep memory small on phones
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext; if (!OAC) return null;
    const buf = await blob.arrayBuffer(), ctx = new OAC(1, 8000, 8000);
    const ab = await new Promise((ok, no) => { const p = ctx.decodeAudioData(buf, ok, no); if (p && p.then) p.then(ok, no); });
    const d = ab.getChannelData(0), n = 96, L = Math.floor(d.length / n), pk = [];
    for (let i = 0; i < n; i++) { let s = 0; for (let j = i * L; j < (i + 1) * L; j += 4) s += d[j] * d[j]; pk.push(Math.sqrt(s / (L / 4))); }
    const m = Math.max(...pk) || 1; return { peaks: pk.map(v => +(v / m).toFixed(2)), duration: ab.duration };
  } catch (e) { return null; }
}
function durationOf(url) { return new Promise(ok => { const a = new Audio(); a.preload = 'metadata'; a.onloadedmetadata = () => ok(a.duration); a.onerror = () => ok(0); a.src = url; setTimeout(() => ok(0), 8000); }); }

async function addFiles(files) {
  files = [...files].filter(f => /audio|mpeg|mp3|m4a|wav|aac|ogg/i.test(f.type + f.name)); if (!files.length) return;
  toast(`Adding ${files.length} song${files.length > 1 ? 's' : ''}…`);
  let added = 0, lastIdx = -1;
  for (const f of files) {
    try {
      const tags = await readID3(f).catch(() => ({}));
      const title = tags.title || f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled';
      const cover = tags.picture || await genCover(title);
      const curl = URL.createObjectURL(cover), color = await dominantColor(curl); URL.revokeObjectURL(curl);
      const pk = await peaksFor(f), aurl = URL.createObjectURL(f);
      const duration = pk && pk.duration || await durationOf(aurl); URL.revokeObjectURL(aurl);
      const rec = { id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title, artist: tags.artist || 'Odisus', style: tags.genre || 'Added from phone',
        color, duration, peaks: pk ? pk.peaks : null, blob: f, cover, added: Date.now() };
      await dbPut(rec);
      const s = fromRecord(rec); predecode(s); const dup = lib.findIndex(x => x.pending && x.title.toLowerCase() === title.toLowerCase());
      if (dup >= 0) { s.color = lib[dup].color || s.color; lib[dup] = s; lastIdx = dup; } else { lib.push(s); lastIdx = lib.length - 1; }
      added++;
    } catch (e) { console.warn('add failed', e); }
  }
  if (!added) { toast("Couldn't read that file"); return; }
  const was = !au.paused; rebuildQueue(lib[lastIdx]); renderStack(false); showSong(1); renderList(); followFront(was);
  toast(`Added ${added} song${added > 1 ? 's' : ''} ✓`);
}

// ---------- library + queue ----------
function shuffled(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function rebuildQueue(keep) {
  keep = keep || cur();
  let idx = lib.map((s, i) => i).filter(i => !st.favOnly || st.favs.includes(lib[i].id));
  if (st.favOnly && !idx.length) { st.favOnly = false; save(); toast('No favorites yet: tap ♥ on a song'); idx = lib.map((s, i) => i); }
  if (st.shuffle) { idx = shuffled(idx); const k = idx.indexOf(lib.indexOf(keep)); if (k > 0) idx.unshift(idx.splice(k, 1)[0]); }
  queue = idx;
  const k = queue.indexOf(lib.indexOf(keep)); pos = k >= 0 ? k : 0;
}

// ---------- 3D stack ----------
const cards = new Map();   // virtual index -> element
let geo = {};
function layout() {
  const w = stage.clientWidth, h = stage.clientHeight, W = Math.round(clamp(Math.min(w * .53, h * .52), 120, 240));
  document.documentElement.style.setProperty('--W', W + 'px'); document.documentElement.style.setProperty('--T', Math.round(W * .075) + 'px');
  geo = { W, x0: w * .12, y0: h - W - h * .05, dx: W * .15, dy: W * .19, dz: W * .24 };
}
function slotTf(k) {
  const g = geo; let x, y, z, o = 1, rz = 0;
  if (k < 0) { x = g.x0 - g.W * 1.35; y = g.y0 + g.W * .45; z = g.W * .35; o = 0; rz = -8; }
  else { x = g.x0 + k * g.dx + (k > 0 ? g.dx * 1.1 : 0); y = g.y0 - k * g.dy - (k > 0 ? g.dy * .9 : 0); z = -k * g.dz - (k > 0 ? g.dz * 1.2 : 0) + (k === 0 ? g.W * .1 : 0); o = k >= VISIBLE - 1 ? 0 : k > 10 ? 1 - (k - 10) / 5 : 1; }
  return { t: `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,${z.toFixed(1)}px) rotateY(34deg) rotateX(-4deg) rotateZ(${rz}deg)`, o, sh: k <= 0 ? 0 : Math.min(.6, .1 + k * .035) };
}
const pool = [], decoded = new Map();
function predecode(s) { if (!s.cover || decoded.has(s.cover)) return; const i = new Image(); i.src = s.cover; decoded.set(s.cover, i); if (i.decode) i.decode().catch(() => {}); }   // keeps covers decoded so shuffles never stall on an image
function makeCard(song) {
  const reuse = pool.pop(); if (reuse) { setCardSong(reuse, song); return reuse; }
  const el = document.createElement('div'); el.className = 'case';
  el.innerHTML = '<div class="f-back"></div><div class="f-left"></div><div class="f-right"></div><div class="f-top"></div><div class="f-bot"></div><div class="f-front"><img alt="" draggable="false"><div class="hinge"></div><div class="gloss"></div><div class="shade"></div></div>';
  setCardSong(el, song); return el;
}
function setCardSong(el, song) {
  if (el._song === song) return; el._song = song;
  const img = el.querySelector('img'); img.src = song.cover || ''; el.style.setProperty('--sc', song.color || '#888'); el.dataset.title = song.title;
}
function place(el, k, dur) { const s = slotTf(k); el.style.setProperty('--d', dur + 's'); el.style.transform = s.t; el.style.opacity = s.o; el.style.setProperty('--sh', s.sh); el.style.zIndex = 100 - k; el.classList.toggle('front', k === 0); }
function renderStack(instant, dur = .6) {
  const n = queue.length; $('#empty').hidden = !!n;
  if (!n) { cards.forEach(el => el.remove()); cards.clear(); return; }
  const want = new Set(); for (let v = pos; v < pos + VISIBLE; v++) want.add(v);
  cards.forEach((el, v) => { if (!want.has(v)) {
    cards.delete(v); const k = v < pos ? -1 : VISIBLE;
    if (instant) { el.remove(); return; }
    place(el, k, dur); setTimeout(() => { el.remove(); if (pool.length < 8) pool.push(el); }, dur * 1000 + 60);
  } });
  for (let v = pos; v < pos + VISIBLE; v++) {
    const song = lib[queue[mod(v, n)]]; let el = cards.get(v);
    if (!el) {
      el = makeCard(song); cards.set(v, el); stackEl.appendChild(el);
      if (!instant) { place(el, v === pos && !cards.has(v + 1) ? -1 : (v === pos ? -1 : VISIBLE), 0); el.getBoundingClientRect(); }
    } else setCardSong(el, song);
    place(el, v - pos, instant ? 0 : dur);
  }
}
function step(dir, dur) { if (!queue.length) return; pos += dir; renderStack(false, dur); if (!picking) buzz(8); }

// ---------- now playing UI ----------
let bgFlip = 0, lastBg = '';
function setBg(song) {
  const key = song.cover + song.color; if (key === lastBg) return; lastBg = key;
  const nx = $('#bg' + (bgFlip ^ 1)), old = $('#bg' + bgFlip); bgFlip ^= 1;
  nx.style.setProperty('--img', song.cover ? `url("${song.cover}")` : 'none'); nx.style.setProperty('--c', song.color || '#444');
  nx.classList.add('on'); old.classList.remove('on');
  document.documentElement.style.setProperty('--accent', song.color || '#6a5cff');
  document.querySelector('meta[name=theme-color]').content = song.color ? `color-mix(in srgb, ${song.color} 30%, #000)` : '#0b0b10';
}
let infoAnim = 0;
function showSong(dir) {
  const s = cur(); if (!s) { $('#title').textContent = 'SoundStack'; $('#meta').textContent = 'Add songs to get started'; return; }
  const info = $('#info'), set = () => {
    $('#title').textContent = s.title; $('#title').classList.toggle('long', s.title.length > 22);
    $('#meta').textContent = [s.artist, s.duration ? fmt(s.duration) : '', s.style].filter(Boolean).join('  ·  ');
  };
  const id = ++infoAnim;
  if (!dir || !info.animate) set();
  else {
    const off = 12 * dir;
    info.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${-off}px)` }], { duration: 140, easing: 'ease-in', fill: 'forwards' }).onfinish = () => {
      if (id !== infoAnim) return; set();
      info.animate([{ opacity: 0, transform: `translateY(${off}px)` }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    };
  }
  setBg(s); $('#btn-fav').classList.toggle('on', st.favs.includes(s.id)); drawWave(); renderListCur();
}

// ---------- playback ----------
let loadedId = null;
function loadCur() {
  const s = cur(); if (!s) return false;
  if (s.pending) { return false; }
  if (loadedId !== s.id) { loadedId = s.id; au.src = s.url; st.last = s.id; save(); updateSession(); }
  return true;
}
function play() {
  const s = cur(); if (!s) return;
  if (s.pending) { toast('Add this song’s MP3: in Suno tap ⋯ → Download → MP3, then tap ＋'); return; }
  loadCur(); userPaused = false; const p = au.play(); if (p && p.catch) p.catch(e => { if (e.name !== 'AbortError') { userPaused = true; syncPlay(); } });
}
function followFront(wasPlaying) { const s = cur(); if (!s || s.id === loadedId) return; if (wasPlaying && !s.pending) play(); else { au.pause(); loadCur(); } }
function pause() { userPaused = true; au.pause(); }
function toggle() { au.paused ? play() : pause(); }
function go(dir, dur = .6) {
  if (picking || !queue.length) return;
  const wasPlaying = !au.paused || !userPaused;
  step(dir, dur); showSong(dir);
  if (wasPlaying) { if (cur().pending) { au.pause(); } else play(); } else loadCur();
  badge(wasPlaying && !cur().pending ? 'Now playing' : null);
}
function syncPlay() {
  $('#play-path').setAttribute('d', au.paused ? 'M8 5v14l11-7z' : 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z');
  $('#btn-play').setAttribute('aria-label', au.paused ? 'Play' : 'Pause');
  const b = $('#badge'); b.classList.toggle('paused', au.paused);
  if (!au.paused && !b.classList.contains('show')) badge('Now playing');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = au.paused ? 'paused' : 'playing';
}
au.addEventListener('play', syncPlay); au.addEventListener('pause', syncPlay);
au.addEventListener('ended', () => {
  if (st.repeat === 'one') { au.currentTime = 0; play(); return; }
  if (st.repeat === 'off' && mod(pos, queue.length) === queue.length - 1) { userPaused = true; syncPlay(); return; }
  let tries = 0; do { step(1); tries++; } while (cur().pending && tries < queue.length);
  showSong(1); play();
});
// recover from a broken stream (e.g. the service worker took over mid-song on the first visit): reload at the same spot
let errTries = 0, lastT = 0;
const bust = u => u.startsWith('blob:') ? u : u.split('?')[0] + '?r=' + Date.now().toString(36);   // fresh URL so the browser doesn't mix its old network buffer with service-worker data
let errAt = 0;
au.addEventListener('timeupdate', () => { if (au.currentTime > 0) lastT = au.currentTime; if (errTries && au.currentTime > errAt + 5) errTries = 0; });
au.addEventListener('error', () => {
  const s = cur(); if (!au.getAttribute('src') || !s || s.id !== loadedId) return;
  if (errTries++ < 2) { const t = lastT, resume = !userPaused; errAt = t; au.src = bust(s.url); au.addEventListener('loadedmetadata', () => { try { au.currentTime = t; } catch (e) {} }, { once: true }); if (resume) au.play().catch(() => {}); return; }
  if (!userPaused) toast("Couldn't play this song");
});
let lastPos = 0;
au.addEventListener('timeupdate', () => {
  $('#t-cur').textContent = fmt(au.currentTime);
  const now = performance.now(); if (now - lastPos > 1000 && 'mediaSession' in navigator && navigator.mediaSession.setPositionState && isFinite(au.duration)) {
    lastPos = now; try { navigator.mediaSession.setPositionState({ duration: au.duration, position: Math.min(au.currentTime, au.duration), playbackRate: au.playbackRate || 1 }); } catch (e) {}
  }
});
au.addEventListener('loadedmetadata', () => { const s = cur(); if (s && isFinite(au.duration)) { if (!s.duration || Math.abs(s.duration - au.duration) > 1) { s.duration = au.duration; showSong(0); } } drawWave(); });

function absUrl(u) { return new URL(u, location.href).href; }
function updateSession() {
  const s = cur(); if (!s || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.artist || 'Odisus', album: 'SoundStack',
      artwork: s.cover ? [{ src: s.user ? s.cover : absUrl(s.cover), sizes: '600x600', type: 'image/jpeg' }] : [] });
  } catch (e) {}
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession, h = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) {} };
  h('play', play); h('pause', pause); h('previoustrack', () => go(-1)); h('nexttrack', () => go(1));
  h('seekto', d => { au.currentTime = d.seekTime; drawWave(); });
  h('seekbackward', d => { au.currentTime = Math.max(0, au.currentTime - (d.seekOffset || 10)); });
  h('seekforward', d => { au.currentTime = Math.min(au.duration || 1e9, au.currentTime + (d.seekOffset || 10)); });
}

// ---------- waveform scrubber ----------
function fakePeaks(id) { let h = hash(id); return Array.from({ length: 96 }, (_, i) => { h = Math.imul(h ^ (h >>> 13), 1103515245) >>> 0; return .35 + .5 * Math.abs(Math.sin(i / 7 + (h % 100) / 50)) * ((h % 1000) / 1000 * .5 + .5); }); }
let scrubbing = false;
function drawWave() {
  const dpr = window.devicePixelRatio || 1, w = wave.clientWidth, h = wave.clientHeight; if (!w) return;
  if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr); }
  const x = wctx; x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
  const s = cur(); if (!s) return;
  const pk = s.peaks && s.peaks.length ? s.peaks : (s._fp = s._fp || fakePeaks(s.id));
  const d = (loadedId === s.id && isFinite(au.duration) && au.duration) || s.duration || 1, t = loadedId === s.id ? au.currentTime : 0, p = clamp(t / d, 0, 1);
  const n = pk.length, bw = w / n, mid = h * .58;
  for (let i = 0; i < n; i++) {
    const v = Math.max(.08, pk[i]), bh = v * (h * .5), xx = i * bw + bw * .2, played = (i + .5) / n <= p;
    x.fillStyle = played ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.28)';
    x.fillRect(xx, mid - bh, Math.max(1, bw * .55), bh * 1.0); x.fillStyle = played ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.1)'; x.fillRect(xx, mid + 2, Math.max(1, bw * .55), bh * .35);
  }
  const px = p * w; x.fillStyle = '#fff'; x.fillRect(px - 1, 2, 2, h - 4); x.beginPath(); x.arc(px, 4, scrubbing ? 5 : 3.5, 0, 7); x.fill();
  $('#t-dur').textContent = fmt(d); if (!scrubbing) $('#t-cur').textContent = fmt(t);
}
function seekAt(e) {
  const r = wave.getBoundingClientRect(), p = clamp((e.clientX - r.left) / r.width, 0, 1), s = cur(); if (!s || s.pending) return;
  loadCur(); const d = isFinite(au.duration) && au.duration ? au.duration : s.duration || 0;
  if (d) { try { au.currentTime = p * d; } catch (err) {} $('#t-cur').textContent = fmt(p * d); }
  drawWave();
}
wave.addEventListener('pointerdown', e => { scrubbing = true; wave.setPointerCapture(e.pointerId); seekAt(e); });
wave.addEventListener('pointermove', e => { if (scrubbing) seekAt(e); });
const endScrub = () => { scrubbing = false; drawWave(); };
wave.addEventListener('pointerup', endScrub); wave.addEventListener('pointercancel', endScrub);
(function loop() { if (!au.paused || scrubbing) drawWave(); requestAnimationFrame(loop); })();

// ---------- Pick for me (slot-machine spin) ----------
let tctx = null;
function tick(tt) {   // soft mechanical click per card, pitch drops as the spin slows
  try {
    tctx = tctx || new (window.AudioContext || window.webkitAudioContext)(); const t = tctx.currentTime, o = tctx.createOscillator(), g = tctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(1400 - tt * 700, t); o.frequency.exponentialRampToValueAtTime(240, t + .03);
    g.gain.setValueAtTime(.05, t); g.gain.exponentialRampToValueAtTime(.0001, t + .05); o.connect(g).connect(tctx.destination); o.start(t); o.stop(t + .06);
  } catch (e) {}
}
function flash() { const f = $('#glow'); f.classList.remove('burst'); void f.offsetWidth; f.classList.add('burst'); }
let badgeT = 0;
function badge(text, pop) {
  const b = $('#badge'); clearTimeout(badgeT);
  if (!text) { b.classList.remove('show'); return; }
  $('#badge-t').textContent = text; b.classList.add('show');
  if (pop) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
}
async function pick() {
  if (picking || queue.length < 1) return;
  const playable = queue.filter(i => !lib[i].pending); if (!playable.length) { toast('Add a song first'); return; }
  picking = true; const btn = $('#btn-pick'); btn.classList.add('busy'); $('#pick-t').textContent = 'Picking…';
  $('#info').classList.add('picking'); badge('Picking…');
  const n = queue.length; let target;
  do { target = Math.floor(Math.random() * n); } while ((lib[queue[target]].pending || (n > 1 && target === mod(pos, n) && playable.length > 1)));
  const steps = 14 + Math.floor(Math.random() * 6) + mod(target - pos - 14, n);   // always spins a while, lands on target
  for (let i = 0; i < steps; i++) {
    const tt = i / (steps - 1), interval = 55 + 420 * tt * tt * tt;   // fast at first, then eases into the stop
    pos += 1; renderStack(false, Math.min(.7, interval / 1000 * 1.6)); buzz(tt > .7 ? 12 : 6); tick(tt);
    $('#title').textContent = cur().title; $('#title').classList.toggle('long', cur().title.length > 22);
    await new Promise(r => setTimeout(r, interval));
  }
  picking = false; btn.classList.remove('busy'); $('#pick-t').textContent = 'Pick for me';
  $('#info').classList.remove('picking'); showSong(1); play(); badge('✦ Tonight’s pick', true); buzz([20, 40, 30]); flash();
  setTimeout(() => { if (!au.paused) badge('Now playing'); }, 3500);
}

// ---------- swipe on the stack ----------
let sw = null;
stage.addEventListener('pointerdown', e => { if (picking) return; sw = { x: e.clientX, y: e.clientY, t: performance.now() }; stackEl.classList.add('drag'); stage.setPointerCapture(e.pointerId); });
stage.addEventListener('pointermove', e => { if (!sw) return; const d = (-(e.clientX - sw.x) + (e.clientY - sw.y)) / 2; stackEl.style.transform = `translate3d(${(-d * .35).toFixed(1)}px, ${(d * .45).toFixed(1)}px, 0)`; });
const swEnd = e => {
  if (!sw) return; const dx = e.clientX - sw.x, dy = e.clientY - sw.y, dist = Math.hypot(dx, dy), d = -dx + dy; sw = null;
  stackEl.classList.remove('drag'); stackEl.style.transform = '';
  if (dist < 10) { const t = e.target.closest && e.target.closest('.case'); if (t && t.classList.contains('front')) toggle(); return; }
  if (Math.abs(d) > 40) go(d > 0 ? 1 : -1);
};
stage.addEventListener('pointerup', swEnd); stage.addEventListener('pointercancel', e => { sw = null; stackEl.classList.remove('drag'); stackEl.style.transform = ''; });

// ---------- buttons ----------
$('#btn-play').onclick = toggle;
$('#btn-next').onclick = () => go(1);
$('#btn-prev').onclick = () => { if (au.currentTime > 4 && !au.paused) { au.currentTime = 0; return; } go(-1); };
$('#btn-pick').onclick = pick;
$('#btn-fav').onclick = () => {
  const s = cur(); if (!s) return; const i = st.favs.indexOf(s.id);
  if (i >= 0) st.favs.splice(i, 1); else st.favs.push(s.id); save();
  const b = $('#btn-fav'); b.classList.toggle('on', i < 0); b.classList.remove('beat'); void b.offsetWidth; b.classList.add('beat'); renderList();
};
function syncModes() {
  $('#btn-shuffle').classList.toggle('on', st.shuffle); $('#c-shuffle').classList.toggle('on', st.shuffle);
  const rb = $('#btn-repeat'); rb.classList.toggle('on', st.repeat !== 'off'); rb.classList.toggle('one', st.repeat === 'one');
  $('#c-repeat').textContent = 'Repeat: ' + ({ all: 'All', one: 'One', off: 'Off' })[st.repeat]; $('#c-repeat').classList.toggle('on', st.repeat !== 'off');
  $('#c-favs').classList.toggle('on', st.favOnly);
}
function toggleShuffle() { st.shuffle = !st.shuffle; save(); rebuildQueue(); renderStack(false, .5); syncModes(); renderList(); toast(st.shuffle ? 'Shuffle on' : 'Shuffle off'); }
function cycleRepeat() { st.repeat = ({ all: 'one', one: 'off', off: 'all' })[st.repeat]; save(); syncModes(); toast('Repeat: ' + ({ all: 'all songs', one: 'this song', off: 'off' })[st.repeat]); }
$('#btn-shuffle').onclick = toggleShuffle; $('#c-shuffle').onclick = toggleShuffle;
$('#btn-repeat').onclick = cycleRepeat; $('#c-repeat').onclick = cycleRepeat;
$('#c-favs').onclick = () => { const was = !au.paused; st.favOnly = !st.favOnly; save(); rebuildQueue(); renderStack(false, .5); showSong(0); syncModes(); renderList(); followFront(was); };
const fileIn = $('#file');
$('#btn-add').onclick = () => fileIn.click(); $('#sheet-add').onclick = () => fileIn.click();
fileIn.onchange = () => { const f = fileIn.files; addFiles(f).finally(() => { fileIn.value = ''; }); };

// ---------- library sheet + search ----------
const sheet = $('#sheet');
function openSheet(search) {
  sheet.hidden = false; $('#sheet-h').textContent = search ? 'Search' : 'Library'; $('#q').value = ''; renderList();
  if (search) setTimeout(() => $('#q').focus(), 50);
}
$('#btn-menu').onclick = () => openSheet(false); $('#btn-search').onclick = () => openSheet(true);
$('#sheet-close').onclick = () => { sheet.hidden = true; };
sheet.addEventListener('click', e => { if (e.target === sheet) sheet.hidden = true; });
$('#q').addEventListener('input', renderList);
const heartSvg = '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';
const xSvg = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';
function renderList() {
  if (sheet.hidden) return;
  const q = $('#q').value.trim().toLowerCase(), ul = $('#list'); ul.innerHTML = '';
  const items = lib.map((s, i) => [s, i]).filter(([s]) => !q || (s.title + ' ' + s.style + ' ' + s.artist).toLowerCase().includes(q));
  if (!items.length) { ul.innerHTML = '<li class="none">No songs match</li>'; return; }
  for (const [s, i] of items) {
    const li = document.createElement('li'); li.dataset.i = i; if (cur() === s) li.classList.add('cur');
    li.innerHTML = `<img alt="" src="${s.cover || ''}"><div class="lt"><b></b><span></span></div><button class="lh${st.favs.includes(s.id) ? ' on' : ''}" aria-label="Favorite">${heartSvg}</button>${s.user ? `<button class="lx" aria-label="Remove">${xSvg}</button>` : ''}`;
    li.querySelector('b').textContent = s.title; li.querySelector('span').textContent = [s.duration ? fmt(s.duration) : '', s.pending ? 'MP3 not added yet' : s.style].filter(Boolean).join(' · ');
    ul.appendChild(li);
  }
}
function renderListCur() { if (sheet.hidden) return; const c = cur(); $('#list').querySelectorAll('li[data-i]').forEach(li => li.classList.toggle('cur', lib[+li.dataset.i] === c)); }
$('#list').addEventListener('click', async e => {
  const li = e.target.closest('li[data-i]'); if (!li) return; const s = lib[+li.dataset.i];
  if (e.target.closest('.lh')) { const k = st.favs.indexOf(s.id); if (k >= 0) st.favs.splice(k, 1); else st.favs.push(s.id); save(); renderList(); if (cur() === s) $('#btn-fav').classList.toggle('on', k < 0); return; }
  if (e.target.closest('.lx')) {
    if (!confirm(`Remove "${s.title}" from this phone?`)) return;
    await dbDel(s.id); if (cur() === s) { au.pause(); au.removeAttribute('src'); loadedId = null; }
    const keep = cur() === s ? null : cur(); lib.splice(lib.indexOf(s), 1); rebuildQueue(keep || lib[0]); cards.forEach(el => el.remove()); cards.clear(); renderStack(true); showSong(0); renderList(); return;
  }
  jumpTo(s); sheet.hidden = true;
});
function jumpTo(s) {
  let k = queue.indexOf(lib.indexOf(s));
  if (k < 0) { st.favOnly = false; save(); syncModes(); rebuildQueue(s); renderStack(false); k = queue.indexOf(lib.indexOf(s)); }
  const n = queue.length, fwd = mod(k - pos, n); if (fwd) { pos += fwd; renderStack(false, .6); }
  showSong(1); play();
}

// ---------- misc ----------
const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };
let toastT = 0;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === ' ') { e.preventDefault(); toggle(); } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') go(1); else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') go(-1);
});
let rz = 0; window.addEventListener('resize', () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { layout(); renderStack(true); drawWave(); }); });
// Fill in missing tags / art for bundled songs straight from the MP3's ID3 tag
async function enrichBundled(s) {
  try {
    const r = await fetch(s.url, { headers: { Range: 'bytes=0-524287' } }); if (!r.ok) return;
    const tags = await readID3(await r.blob());
    if (!s._titleSet && tags.title) s.title = tags.title; if (!s._artistSet && tags.artist) s.artist = tags.artist;
    if (!s.cover) s.cover = tags.picture ? URL.createObjectURL(tags.picture) : URL.createObjectURL(await genCover(s.title));
    if (!s.color) s.color = await dominantColor(s.cover);
    cards.forEach(el => { if (el._song === s) { el._song = null; setCardSong(el, s); } }); if (cur() === s) { lastBg = ''; showSong(0); }
  } catch (e) {}
}

async function init() {
  lib = (window.SONGS || []).map((s, i) => ({ id: 'b:' + (s.file || s.title), title: s.title || (s.file || '').split('/').pop().replace(/\.[^.]+$/, ''), artist: s.artist || 'Odisus', style: s.style || '', cover: s.cover || '', color: s.color || '',
    duration: s.duration || 0, peaks: s.peaks || null, url: s.file || '', pending: !s.file, suno: s.suno, _titleSet: !!s.title, _artistSet: !!s.artist, featured: !!s.featured }));
  try { (await dbAll()).sort((a, b) => a.added - b.added).forEach(r => {
    const s = fromRecord(r), dup = lib.findIndex(x => x.pending && x.title.toLowerCase() === r.title.toLowerCase());
    if (dup >= 0) { s.color = lib[dup].color || s.color; lib[dup] = s; } else lib.push(s);
  }); } catch (e) { console.warn('IndexedDB unavailable', e); }
  lib.forEach(predecode);
  layout();
  const last = lib.find(s => s.id === st.last && !s.pending) || lib.find(s => s.featured && !s.pending) || lib.find(s => !s.pending) || lib[0];
  rebuildQueue(last); renderStack(true); syncModes(); showSong(0); loadCur(); syncPlay();
  lib.filter(s => !s.user && s.url && (!s.cover || !s.color || !s._titleSet)).forEach(enrichBundled);
  // entrance: cards fly in from the back
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) cards.forEach((el, v) => { const k = v - pos; place(el, VISIBLE, 0); el.getBoundingClientRect(); setTimeout(() => place(el, k, .9), 60 + k * 45); });
}
window.SS = { get lib() { return lib; }, get queue() { return queue; }, get pos() { return pos; }, get picking() { return picking; }, cur, au, readID3, dominantColor, addFiles, go, pick, play, pause };
init();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { const s = cur(); if (au.paused && s && s.id === loadedId && !s.user) { const t = au.currentTime; au.src = bust(s.url); if (t) au.addEventListener('loadedmetadata', () => { au.currentTime = t; }, { once: true }); } });
}
})();
