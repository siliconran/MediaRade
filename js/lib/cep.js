/* =============================================================================
   cep.js — slim bridge to the CEP host (no CSInterface.js dependency)
   Talks straight to window.__adobe_cep__ and exposes Node through cep_node.
   MediaRade by rad1x
   ========================================================================== */
(function (global) {
  'use strict';

  var raw = global.__adobe_cep__ || null;

  /* --- Node.js -------------------------------------------------------------
     With --enable-nodejs + --mixed-context CEP exposes `cep_node`. In some
     builds plain `require` is also global. Try both, fail soft so the panel
     still renders (in degraded mode) when Node is unavailable.               */
  function resolveRequire() {
    if (global.cep_node && typeof global.cep_node.require === 'function') return global.cep_node.require;
    if (typeof global.require === 'function') return global.require;
    return null;
  }

  var _require = resolveRequire();
  var nodeOK = !!_require;

  function need(mod) {
    if (!nodeOK) throw new Error('MediaRade requires Node.js in the CEP panel (--enable-nodejs). Module "' + mod + '" is unavailable.');
    return _require(mod);
  }

  var CEP = {
    available: !!raw,
    nodeAvailable: nodeOK,

    require: function (mod) { return need(mod); },

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
      var map = {
        userData: 'userData', common: 'commonFiles', myDocuments: 'myDocuments',
        application: 'application', extension: 'extension', hostApplication: 'hostApplication'
      };
      var p = '';
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
      var s = String(p).replace(/\\/g, '/');
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
      if (raw && raw.invokeSync) { try { return raw.invokeSync('openURLInDefaultBrowser', url); } catch (e) { /* fall through */ } }
      try { CEP.cp.spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true }).unref(); } catch (e) {}
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

  global.CEP = CEP;
})(window);
