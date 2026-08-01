/* =============================================================================
   host.js — in-browser demo shim for CEP's Node host.
   When the panel is opened outside CEP (a plain browser, for design iteration)
   there is no __adobe_cep__ bridge and no Node runtime, so the fs / path / os /
   child_process getters on CEP would throw. This file swaps in an in-memory
   filesystem plus a process stub so the UI boots in demo mode — enough to
   review the layout and flow. Searches and downloads report a clear error.
   It is never active inside Premiere Pro, where the real host is present.
   MediaRade by rad1x
   ========================================================================== */
import { CEP } from './cep.js';

if (CEP.available || CEP.nodeAvailable) {
  console.warn('[MediaRade] real CEP host present.');
} else {
  console.warn('[MediaRade] demo mode: no CEP host — in-memory storage, downloads disabled.');

  /* --- in-memory filesystem ---------------------------------------------- */

  const files = {};   // normalized absolute path -> string content
  const dirs = {};    // normalized absolute path -> true

  function norm(p) {
    return String(p || '').replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/\\+$/, '').toLowerCase();
  }

  function ensureParent(p) { dirs[norm(path.dirname(p))] = true; }

  const fs = {
    mkdirSync: function (p) { dirs[norm(p)] = true; },
    existsSync: function (p) {
      const k = norm(p);
      return files[k] !== undefined || !!dirs[k] || k === 'c:';
    },
    readFileSync: function (p) {
      const k = norm(p);
      if (files[k] === undefined) { const e = new Error('ENOENT: no such file'); e.code = 'ENOENT'; throw e; }
      return files[k];
    },
    writeFileSync: function (p, data) { ensureParent(p); files[norm(p)] = String(data); },
    appendFileSync: function (p, data) { ensureParent(p); const k = norm(p); files[k] = (files[k] || '') + String(data); },
    renameSync: function (a, b) {
      const ka = norm(a), kb = norm(b);
      if (files[ka] !== undefined) { files[kb] = files[ka]; delete files[ka]; }
      dirs[kb] = true;
    },
    statSync: function (p) {
      const k = norm(p);
      if (files[k] === undefined) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      const mtime = Date.now();
      return { size: files[k].length, mtime: mtime, mtimeMs: mtime, isFile: () => true, isDirectory: () => false };
    },
    unlinkSync: function (p) { const k = norm(p); if (files[k] !== undefined) delete files[k]; }
  };

  /* --- path / os ------------------------------------------------------------ */

  const path = {
    sep: '\\',
    join: function () {
      const out = [];
      for (let i = 0; i < arguments.length; i++) {
        const s = String(arguments[i] || '').replace(/\//g, '\\').replace(/\\+$/, '');
        if (s) out.push(s);
      }
      return out.join('\\');
    },
    dirname: function (p) {
      p = String(p || '').replace(/\//g, '\\').replace(/\\+$/, '');
      const i = p.lastIndexOf('\\');
      return i < 0 ? '' : (i === 0 ? '\\' : p.slice(0, i));
    },
    basename: function (p, ext) {
      p = String(p || '').replace(/\//g, '\\').replace(/\\+$/, '');
      let b = p.slice(p.lastIndexOf('\\') + 1);
      if (ext) {
        const e = String(ext);
        if (b.toLowerCase().slice(-e.length) === e.toLowerCase()) b = b.slice(0, -e.length);
      }
      return b;
    },
    extname: function (p) {
      const b = String(p || '').replace(/\//g, '\\').split('\\').pop();
      const i = b.lastIndexOf('.');
      return i <= 0 ? '' : b.slice(i);
    }
  };

  const os = { homedir: () => 'C:/Users/Public' };

  /* --- process stub ---------------------------------------------------------- */

  function noop() {}

  function fakeChild() {
    const self = {
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

  const cp = { spawn: () => fakeChild() };
  const https = { request: () => { throw new Error('https is unavailable in demo mode'); } };

  /* --- swap the CEP getters -------------------------------------------------- */

  Object.defineProperties(CEP, {
    fs:    { get: () => fs,    configurable: true },
    path:  { get: () => path,  configurable: true },
    os:    { get: () => os,    configurable: true },
    cp:    { get: () => cp,    configurable: true },
    https: { get: () => https, configurable: true }
  });
}
