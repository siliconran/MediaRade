/* =============================================================================
   util.js — tiny helpers shared by every module. MediaRade by siliconran
   ========================================================================== */

/* --- DOM ------------------------------------------------------------- */
export function $(sel, root) { return (root || document).querySelector(sel); }
export function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

export function el(tag, attrs, children) {
  const n = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (k) {
    const v = attrs[k];
    if (v === null || v === undefined || v === false) return;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'data' && typeof v === 'object') Object.keys(v).forEach(function (d) { n.dataset[d] = v[d]; });
    else n.setAttribute(k, v === true ? '' : v);
  });
  append(n, children);
  return n;
}

export function append(parent, children) {
  if (children === null || children === undefined) return parent;
  (Array.isArray(children) ? children : [children]).forEach(function (c) {
    if (c === null || c === undefined || c === false) return;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  });
  return parent;
}

export function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }

export function icon(id, size) {
  const s = size || 20;
  return '<svg class="ps2-tile__glyph" width="' + s + '" height="' + s + '" viewBox="0 0 24 24"><use href="#i-' + id + '"/></svg>';
}

/* --- escaping ---------------------------------------------------------- */
export function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* --- formatting -------------------------------------------------------- */
export function hhmmss(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
}

/** Whole-second timecode, HH:MM:SS:FF at the given fps. */
export function timecode(sec, fps) {
  sec = Math.max(0, Number(sec) || 0);
  fps = fps || 25;
  let t = Math.floor(sec), f = Math.round((sec - t) * fps);
  if (f >= fps) { f = 0; t += 1; }
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return p(Math.floor(t / 3600)) + ':' + p(Math.floor((t % 3600) / 60)) + ':' + p(t % 60) + ':' + p(f);
}

/** Accepts 90, "1:30", "00:01:30", "1:30.5" -> seconds. */
export function parseTime(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(':').map(parseFloat);
  if (parts.some(isNaN)) return null;
  let out = 0;
  for (let i = 0; i < parts.length; i++) out = out * 60 + parts[i];
  return out;
}

export function bytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
}

export function compact(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/** yt-dlp gives upload_date as YYYYMMDD. */
export function ymd(d) {
  if (!d) return '';
  const s = String(d);
  return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s;
}

export function ago(ymd) {
  if (!ymd || String(ymd).length !== 8) return '';
  const s = String(ymd);
  const then = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days < 0) return '';
  if (days < 1) return 'today';
  if (days < 30) return days + 'd ago';
  if (days < 365) return Math.floor(days / 30) + 'mo ago';
  return Math.floor(days / 365) + 'y ago';
}

/* --- strings ----------------------------------------------------------- */
export function slug(s, max) {
  const DIRTY = new RegExp('[\\u0000-\\u001f\\u007f\\u0080-\\u009f\\ufffd]', 'g');
  let out = String(s || 'untitled')
    .replace(DIRTY, '')
    .replace(/[\\/:*?"<>|]/g, ' ')          // illegal on NTFS
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');                  // trailing dot/space breaks Windows
  if (!out) out = 'untitled';
  return out.slice(0, max || 90);
}

export function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function uid(p) {
  return (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* --- youtube ----------------------------------------------------------- */
/* Every shape a YouTube video address turns up in. Covers the old /v/ embed and
   music.youtube.com alongside the modern ones, and tolerates a trailing ?t=,
   &list=, tracking parameters or a copied "watch?v=…&feature=share". An 11-char
   id on its own is accepted so a pasted id works like a link. */
export function videoId(urlOrId) {
  const s = String(urlOrId || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:[?&]v=|\/shorts\/|\/embed\/|\/v\/|youtu\.be\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/** True when the text is a YouTube address of any kind we understand — video,
    channel or playlist. Used to offer a direct action instead of a search. */
export function isYouTubeUrl(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(s);
}

/** The playlist id in a URL, or null. A watch URL carrying &list= is still a
    single video, so this only reports a LIST-first address (/playlist?list=). */
export function playlistId(urlOrId) {
  const s = String(urlOrId || '').trim();
  if (!/\/playlist\?/i.test(s)) return null;
  const m = s.match(/[?&]list=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export function thumb(id, quality) {
  return id ? 'https://i.ytimg.com/vi/' + id + '/' + (quality || 'mqdefault') + '.jpg' : '';
}

export function watchUrl(id) { return 'https://www.youtube.com/watch?v=' + id; }

/* --- async ------------------------------------------------------------- */
export function debounce(fn, ms) {
  let t;
  return function () {
    const a = arguments, self = this;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(self, a); }, ms || 250);
  };
}

export function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/** Run `worker` over `items` with bounded concurrency, in order of completion. */
export function pool(items, limit, worker) {
  return new Promise(function (resolve) {
    let i = 0, active = 0, done = 0;
    const results = new Array(items.length);
    if (!items.length) return resolve(results);
    function pump() {
      while (active < limit && i < items.length) {
        (function (idx) {
          active++; i++;
          Promise.resolve()
            .then(function () { return worker(items[idx], idx); })
            .then(function (r) { results[idx] = r; }, function (e) { results[idx] = { error: e }; })
            .then(function () {
              active--; done++;
              if (done === items.length) resolve(results); else pump();
            });
        })(i);
      }
    }
    pump();
  });
}

export function copy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch (e) { return false; }
}

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

const U = {
  $, $$, el, append, clear, icon,
  esc, hhmmss, timecode, parseTime, bytes, compact, ymd, ago,
  slug, truncate, uid, videoId, isYouTubeUrl, playlistId, thumb, watchUrl,
  debounce, sleep, pool, copy, clamp
};

export default U;
