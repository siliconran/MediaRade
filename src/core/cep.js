/* =============================================================================
   cep.js — slim bridge to the CEP host (no CSInterface.js dependency).
   Talks straight to window.__adobe_cep__ and exposes Node through cep_node.
   MediaRade by rad1x
   ========================================================================== */

const raw = globalThis.__adobe_cep__ || null;

/* --- Node.js -------------------------------------------------------------
   With --enable-nodejs + --mixed-context CEP exposes `cep_node`. In some
   builds plain `require` is also global. Try both, fail soft so the panel
   still renders (in degraded mode) when Node is unavailable.               */
function resolveRequire() {
  if (globalThis.cep_node && typeof globalThis.cep_node.require === 'function') return globalThis.cep_node.require;
  if (typeof globalThis.require === 'function') return globalThis.require;
  return null;
}

const _require = resolveRequire();
const nodeOK = !!_require;

function need(mod) {
  if (!nodeOK) throw new Error('MediaRade requires Node.js in the CEP panel (--enable-nodejs). Module "' + mod + '" is unavailable.');
  return _require(mod);
}

export const CEP = {
  available: !!raw,
  nodeAvailable: nodeOK,

  require: (mod) => need(mod),

  /* lazily-bound node modules */
  get fs()   { return need('fs'); },
  get path() { return need('path'); },
  get os()   { return need('os'); },
  get cp()   { return need('child_process'); },
  get https(){ return need('https'); },

  /* --- host script --------------------------------------------------- */
  evalScript: function (script) {
    return new Promise(function (resolve, reject) {
      if (!raw) return reject(new Error('Not running inside CEP.'));
      try {
        raw.evalScript(script, function (res) {
          if (res === 'EvalScript error.') return reject(new Error('ExtendScript error while running: ' + script));
          resolve(res);
        });
      } catch (e) { reject(e); }
    });
  },

  /* --- environment ---------------------------------------------------- */
  hostEnvironment: function () {
    if (!raw) return null;
    try { return JSON.parse(raw.getHostEnvironment()); } catch (e) { return null; }
  },

  /** PathType: userData | common | myDocuments | application | extension | hostApplication */
  systemPath: function (type) {
    if (!raw) return '';
    const map = {
      userData: 'userData', common: 'commonFiles', myDocuments: 'myDocuments',
      application: 'application', extension: 'extension', hostApplication: 'hostApplication'
    };
    let p = '';
    try { p = raw.getSystemPath(map[type] || type); } catch (e) { return ''; }
    // CEP hands back a file:// URL with percent escapes on Windows.
    return CEP.fromFileUrl(p);
  },

  fromFileUrl: function (p) {
    if (!p) return '';
    p = String(p);
    if (p.indexOf('file:///') === 0) p = p.slice(8);
    else if (p.indexOf('file://') === 0) p = p.slice(7);
    try { p = decodeURIComponent(p); } catch (e) { /* leave as-is */ }
    return p.replace(/\//g, '\\').replace(/^\\([A-Za-z]:)/, '$1');
  },

  toFileUrl: function (p) {
    if (!p) return '';
    let s = String(p).replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(s)) s = '/' + s;
    return 'file://' + s.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':');
  },

  /* --- host events ----------------------------------------------------- */
  on: function (type, handler) {
    if (raw && raw.addEventListener) raw.addEventListener(type, handler);
  },
  off: function (type, handler) {
    if (raw && raw.removeEventListener) raw.removeEventListener(type, handler);
  },

  /* --- misc ------------------------------------------------------------ */
  openInBrowser: function (url) {
    url = String(url || '');
    if (!url) return;
    // 1) window.open — CEP hosts hand external http(s) popups to the OS
    //    browser. Cheap and non-blocking; skipped when popups are blocked.
    try {
      const w = window.open(url, '_blank');
      if (w && !w.closed) return;
    } catch (e) {}
    // 2) rundll32 url.dll,FileProtocolHandler — the classic, reliable way to
    //    hand a URL to the default browser on Windows. Node is confirmed
    //    present (downloads already spawn child processes).
    try {
      CEP.cp.spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, detached: true }).unref();
      return;
    } catch (e) {}
    // 3) cmd /c start (older PowerShell-less fallback).
    try {
      CEP.cp.spawn('cmd', ['/c', 'start', '""', url], { windowsHide: true, detached: true }).unref();
      return;
    } catch (e) {}
    // 4) PowerShell Start-Process.
    try {
      CEP.cp.spawn('powershell.exe',
        ['-NoProfile', '-Command', 'Start-Process', '"' + url.replace(/"/g, '""') + '"'],
        { windowsHide: true, detached: true }).unref();
      return;
    } catch (e) {}
    // 5) explorer — opens the URL in the default browser too.
    try { CEP.cp.spawn('explorer.exe', [url], { detached: true }).unref(); } catch (e2) {}
    // 6) CEP's documented host API, exactly as CSInterface.openURLInDefaultBrowser
    //    uses it — note the interface is 'external', not the URL. Kept last
    //    because invokeSync is synchronous and must never block the panel.
    if (raw && raw.invokeSync) {
      try { raw.invokeSync('external', 'openURLInDefaultBrowser', url); } catch (e) {}
    }
  },

  revealInExplorer: function (filePath) {
    try {
      CEP.cp.spawn('explorer.exe', ['/select,', filePath.replace(/\//g, '\\')], { windowsHide: false, detached: true }).unref();
    } catch (e) {}
  },

  openFolder: function (dir) {
    try { CEP.cp.spawn('explorer.exe', [dir.replace(/\//g, '\\')], { detached: true }).unref(); } catch (e) {}
  },

  /** Panel geometry hint so we can adapt the layout. */
  resizeHost: function (w, h) {
    if (raw && raw.resizeContent) { try { raw.resizeContent(w, h); } catch (e) {} }
  }
};
