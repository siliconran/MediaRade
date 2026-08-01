/* =============================================================================
   util.js — tiny helpers shared by every module. MediaRade by rad1x
   ========================================================================== */
(function (global) {
  'use strict';

  var U = {};

  /* --- DOM ------------------------------------------------------------- */
  U.$  = function (sel, root) { return (root || document).querySelector(sel); };
  U.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  U.el = function (tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'data' && typeof v === 'object') Object.keys(v).forEach(function (d) { n.dataset[d] = v[d]; });
      else n.setAttribute(k, v === true ? '' : v);
    });
    U.append(n, children);
    return n;
  };

  U.append = function (parent, children) {
    if (children === null || children === undefined) return parent;
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return parent;
  };

  U.clear = function (n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; };

  U.icon = function (id, size) {
    var s = size || 20;
    return '<svg class="ps2-tile__glyph" width="' + s + '" height="' + s + '" viewBox="0 0 24 24"><use href="#i-' + id + '"/></svg>';
  };

  /* --- escaping ---------------------------------------------------------- */
  U.esc = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /* --- formatting -------------------------------------------------------- */
  U.hhmmss = function (sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
  };

  /** Whole-second timecode, HH:MM:SS:FF at the given fps. */
  U.timecode = function (sec, fps) {
    sec = Math.max(0, Number(sec) || 0);
    fps = fps || 25;
    var t = Math.floor(sec), f = Math.round((sec - t) * fps);
    if (f >= fps) { f = 0; t += 1; }
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return p(Math.floor(t / 3600)) + ':' + p(Math.floor((t % 3600) / 60)) + ':' + p(t % 60) + ':' + p(f);
  };

  /** Accepts 90, "1:30", "00:01:30", "1:30.5" -> seconds. */
  U.parseTime = function (v) {
    if (v === null || v === undefined || v === '') return null;
    var s = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    var parts = s.split(':').map(parseFloat);
    if (parts.some(isNaN)) return null;
    var out = 0;
    for (var i = 0; i < parts.length; i++) out = out * 60 + parts[i];
    return out;
  };

  U.bytes = function (n) {
    n = Number(n) || 0;
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
  };

  U.compact = function (n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  };

  /** yt-dlp gives upload_date as YYYYMMDD. */
  U.ymd = function (d) {
    if (!d) return '';
    var s = String(d);
    return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s;
  };

  U.ago = function (ymd) {
    if (!ymd || String(ymd).length !== 8) return '';
    var s = String(ymd);
    var then = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    var days = Math.floor((Date.now() - then.getTime()) / 86400000);
    if (days < 0) return '';
    if (days < 1) return 'today';
    if (days < 30) return days + 'd ago';
    if (days < 365) return Math.floor(days / 30) + 'mo ago';
    return Math.floor(days / 365) + 'y ago';
  };

  /* --- strings ----------------------------------------------------------- */
  U.slug = function (s, max) {
    var CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
    var out = String(s || 'untitled')
      .replace(CONTROL, '')
      .replace(/[\\/:*?"<>|]/g, ' ')          // illegal on NTFS
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '');                  // trailing dot/space breaks Windows
    if (!out) out = 'untitled';
    return out.slice(0, max || 90);
  };

  U.truncate = function (s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  U.uid = function (p) {
    return (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  };

  /* --- youtube ----------------------------------------------------------- */
  U.videoId = function (urlOrId) {
    var s = String(urlOrId || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    var m = s.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/|\/live\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  };

  U.thumb = function (id, quality) {
    return id ? 'https://i.ytimg.com/vi/' + id + '/' + (quality || 'mqdefault') + '.jpg' : '';
  };

  U.watchUrl = function (id) { return 'https://www.youtube.com/watch?v=' + id; };

  /* --- async ------------------------------------------------------------- */
  U.debounce = function (fn, ms) {
    var t;
    return function () {
      var a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, a); }, ms || 250);
    };
  };

  U.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /** Run `worker` over `items` with bounded concurrency, in order of completion. */
  U.pool = function (items, limit, worker) {
    return new Promise(function (resolve) {
      var i = 0, active = 0, results = new Array(items.length), done = 0;
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
  };

  U.copy = function (text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch (e) { return false; }
  };

  U.clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };

  global.U = U;
})(window);
