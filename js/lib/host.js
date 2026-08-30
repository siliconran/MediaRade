/* =============================================================================
   host.js — in-browser demo shim for CEP's Node host.
   When the panel is opened outside CEP (a plain browser, for design iteration)
   there is no __adobe_cep__ bridge and no Node runtime, so the fs / path / os /
   child_process getters on CEP would throw. This file swaps in an in-memory
   filesystem plus a process stub so the UI boots in demo mode — enough to
   review the layout and flow. Searches and downloads report a clear error.
   It is never active inside Premiere Pro, where the real host is present.
   MediaRade by sgtsilicon
   ========================================================================== */
(function (global) {
  'use strict';

  if (CEP.available || CEP.nodeAvailable) return;   // real host is present

  console.warn('[MediaRade] demo mode: no CEP host — in-memory storage, downloads disabled.');

  /* --- in-memory filesystem ---------------------------------------------- */

  var files = {};   // normalized absolute path -> string content
  var dirs = {};    // normalized absolute path -> true

  function norm(p) {
    return String(p || '').replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/\\+$/, '').toLowerCase();
  }

  function ensureParent(p) { dirs[norm(path.dirname(p))] = true; }

  var fs = {
    mkdirSync: function (p) { dirs[norm(p)] = true; },
    existsSync: function (p) {
      var k = norm(p);
      return files[k] !== undefined || !!dirs[k] || k === 'c:';
    },
    readFileSync: function (p) {
      var k = norm(p);
      if (files[k] === undefined) { var e = new Error('ENOENT: no such file'); e.code = 'ENOENT'; throw e; }
      return files[k];
    },
    writeFileSync: function (p, data) { ensureParent(p); files[norm(p)] = String(data); },
    appendFileSync: function (p, data) { ensureParent(p); var k = norm(p); files[k] = (files[k] || '') + String(data); },
    renameSync: function (a, b) {
      var ka = norm(a), kb = norm(b);
      if (files[ka] !== undefined) { files[kb] = files[ka]; delete files[ka]; }
      dirs[kb] = true;
    },
    statSync: function (p) {
      var k = norm(p);
      if (files[k] === undefined) { var e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { size: files[k].length, isFile: function () { return true; }, isDirectory: function () { return false; } };
    },
    unlinkSync: function (p) { var k = norm(p); if (files[k] !== undefined) delete files[k]; }
  };

  /* --- path / os ------------------------------------------------------------ */

  var path = {
    sep: '\\',
    join: function () {
      var out = [];
      for (var i = 0; i < arguments.length; i++) {
        var s = String(arguments[i] || '').replace(/\//g, '\\').replace(/\\+$/, '');
        if (s) out.push(s);
      }
      return out.join('\\');
    },
    dirname: function (p) {
      p = String(p || '').replace(/\//g, '\\').replace(/\\+$/, '');
      var i = p.lastIndexOf('\\');
      return i < 0 ? '' : (i === 0 ? '\\' : p.slice(0, i));
    },
    basename: function (p, ext) {
      p = String(p || '').replace(/\//g, '\\').replace(/\\+$/, '');
      var b = p.slice(p.lastIndexOf('\\') + 1);
      if (ext) {
        var e = String(ext);
        if (b.toLowerCase().slice(-e.length) === e.toLowerCase()) b = b.slice(0, -e.length);
      }
      return b;
    },
    extname: function (p) {
      var b = String(p || '').replace(/\//g, '\\').split('\\').pop();
      var i = b.lastIndexOf('.');
      return i <= 0 ? '' : b.slice(i);
    }
  };

  var os = { homedir: function () { return 'C:/Users/Public'; } };

  /* --- process stub ---------------------------------------------------------- */

  function noop() {}

  function fakeChild() {
    var self = {
      pid: Math.floor(10000 + Math.random() * 89999),
      stdout: { on: noop, setEncoding: noop },
      stderr: { on: noop, setEncoding: noop },
      kill: noop,
      on: function (evt, cb) { if (evt === 'error') self._onError = cb; }
    };
    setTimeout(function () {
      if (self._onError) self._onError(new Error('Demo mode: the real host is not running. Open this inside Premiere Pro to use it.'));
    }, 0);
    return self;
  }

  var cp = { spawn: function () { return fakeChild(); } };

  var https = { request: function () { throw new Error('https is unavailable in demo mode'); } };

  /* --- swap the CEP getters -------------------------------------------------- */

  Object.defineProperties(CEP, {
    fs:    { get: function () { return fs; },    configurable: true },
    path:  { get: function () { return path; },  configurable: true },
    os:    { get: function () { return os; },    configurable: true },
    cp:    { get: function () { return cp; },    configurable: true },
    https: { get: function () { return https; }, configurable: true }
  });
})(window);
