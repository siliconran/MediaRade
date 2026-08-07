#!/usr/bin/env node
/* =============================================================================
   tools/uppbeat-login.mjs — real-browser Uppbeat login for MediaRade.
   MediaRade by rad1x

   PROBLEM: Uppbeat sits behind Vercel's "Security Checkpoint" (Attack
   Challenge) — a JavaScript proof-of-work that only a real browser can solve.
   Every non-browser HTTP client (curl, Node https, yt-dlp, PowerShell) is
   answered with HTTP 429 regardless of the network/IP it comes from. That is
   why a VPN made no difference.

   FIX: this helper launches a REAL, visible Chrome window and drives it over
   the DevTools Protocol (CDP). Chrome solves the checkpoint itself, we fill in
   the credentials in the actual uppbeat.io login form, and we capture the
   resulting session cookies + the /api/v1/me payload. The panel imports those
   cookies exactly as it would from any other method.

   Zero dependencies on purpose: Node 24's built-in global `WebSocket` talks
   CDP directly, so there is no Playwright / npm runtime to ship or install.
   It runs under the SYSTEM Node (the one that builds this project), not the
   panel's embedded Node.

   Usage:  node uppbeat-login.mjs --email you@example.com [--timeout 120000]
          ...password is read from the FIRST LINE OF STDIN (never argv).

   Prints a single JSON object to stdout:
     { ok:true, cookies:"name=value; ...", me:{...} }
     { ok:false, error:"..." }

   Exit code is 0 on success, 1 on failure.
   ========================================================================== */

import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LOGIN_URL = 'https://uppbeat.io/login';
const DEBUG = typeof process !== 'undefined' && (process.env.UB_DEBUG === '1' || process.env.UB_DEBUG === 'true');
const trace = (...a) => { if (DEBUG) process.stderr.write('[ub] ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); };
const API_BASE = 'https://prod-api.uppbeat.io';
/* The rebuilt SPA serves account/plan state from /api/setup_frontend. A real
   browser shares the .uppbeat.io session cookies with the prod-api subdomain,
   so a plain credentials:'include' fetch is authenticated. The body (not the
   HTTP status) tells us whether the session is valid, and only one field in it
   does: `user.is_authenticated`. Top-level `auth_token` is a decoy — Uppbeat
   issues a token to signed-out visitors and echoes back whatever token cookie
   it is handed, so it reads true for guests and for values it never issued. */
const ACCOUNT_PATH = API_BASE + '/api/setup_frontend?fev=uppbeat-next@1.1.18';

/* Browser registry. Uppbeat's login sits behind a Vercel "security checkpoint"
   that only a real browser can pass, so we drive a genuine window through the
   Chrome DevTools Protocol. Any Chromium-family browser speaks CDP identically,
   so Chrome, Edge, Brave, Opera, Vivaldi and Chromium all work through the same
   code path — just pick a different executable. Firefox-family browsers do NOT
   speak CDP in this helper; they are supported through the cookie-import path
   instead ("Sign in" > "I've signed in — Import session"), which yt-dlp reads
   natively. The env var MR_BROWSER_PATH (or MR_CHROME) overrides the lookup. */
const BROWSER = {
  chrome: {
    label: 'Chrome',
    envs: ['MR_BROWSER_PATH', 'MR_CHROME'],
    exe: 'chrome.exe',
    candidates: [
      '$PF\\Google\\Chrome\\Application\\chrome.exe',
      '$PF86\\Google\\Chrome\\Application\\chrome.exe'
    ]
  },
  edge: {
    label: 'Edge',
    envs: ['MR_BROWSER_PATH'],
    exe: 'msedge.exe',
    candidates: [
      '$PF\\Microsoft\\Edge\\Application\\msedge.exe',
      '$PF86\\Microsoft\\Edge\\Application\\msedge.exe'
    ]
  },
  brave: {
    label: 'Brave',
    envs: ['MR_BROWSER_PATH'],
    exe: 'brave.exe',
    candidates: [
      '$PF\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '$PF86\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      '$LOCALAPPDATA\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    ]
  },
  opera: {
    label: 'Opera',
    envs: ['MR_BROWSER_PATH'],
    exe: 'opera.exe',
    candidates: [
      '$PF\\Opera\\opera.exe',
      '$PF86\\Opera\\opera.exe',
      '$LOCALAPPDATA\\Programs\\Opera\\opera.exe'
    ]
  },
  vivaldi: {
    label: 'Vivaldi',
    envs: ['MR_BROWSER_PATH'],
    exe: 'vivaldi.exe',
    candidates: [
      '$PF\\Vivaldi\\Application\\vivaldi.exe',
      '$PF86\\Vivaldi\\Application\\vivaldi.exe',
      '$LOCALAPPDATA\\Vivaldi\\Application\\vivaldi.exe'
    ]
  },
  chromium: {
    label: 'Chromium',
    envs: ['MR_BROWSER_PATH'],
    exe: 'chrome.exe',
    candidates: [
      '$LOCALAPPDATA\\Chromium\\Application\\chrome.exe',
      'C:\\Program Files\\Chromium\\chrome.exe'
    ]
  }
};

function expand(render) {
  if (!render) return null;
  const vars = { PF: process.env['ProgramFiles'], PF86: process.env['ProgramFiles(x86)'], LOCALAPPDATA: process.env['LOCALAPPDATA'] };
  const out = render.replace(/\$([A-Z0-9]+)/g, (m, name) => vars[name] || '');
  return out || null;
}

/** Resolve the executable for a browser id, honouring explicit override env
 * vars first, then well-known install paths. Returns null if not installed. */
function findBrowser(id) {
  const meta = BROWSER[id] || BROWSER.chrome;
  for (const e of meta.envs) {
    if (e && process.env[e] && existsSync(process.env[e])) return process.env[e];
  }
  for (const c of meta.candidates) {
    const p = expand(c);
    if (p && existsSync(p)) return p;
  }
  return null;
}

/** Read `--browser <id>` from the command line (accepts chrome/edge/brave/
 * opera/vivaldi/chromium, case-insensitive). Defaults to chrome. */
function browserArg() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--browser');
  let id = i > -1 ? String(args[i + 1] || '').trim().toLowerCase() : '';
  if (!id) id = process.env.MR_BROWSER || 'chrome';
  return BROWSER[id] ? id : 'chrome';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- minimal CDP client over Node's global WebSocket ---------------------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && m.id) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error.message || 'CDP error'));
          else p.resolve(m.result);
        }
      }
    });
    ws.addEventListener('close', () => {
      const err = new Error('Chrome debugger connection closed.');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }
  send(method, params, sessionId) {
    const msg = { id: ++this.id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(msg.id, { resolve, reject });
      try { this.ws.send(JSON.stringify(msg)); } catch (e) { this.pending.delete(msg.id); reject(e); }
    });
  }
}

function connectWS(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [], { origin: 'http://127.0.0.1' });
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('Timed out opening the debugger socket.')); }, timeoutMs || 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not open the debugger socket to Chrome.')); });
  });
}

/* Real mouse click at viewport (x, y) via CDP Input domain. A plain
   element.click() is ignored by the Cloudflare Turnstile widget — it guards
   against synthetic events — so we must drive a genuine input mouse sequence. */
async function realClick(cdp, sessionId, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId).catch(() => {});
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId).catch(() => {});
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId).catch(() => {});
}

/* Locate the Cloudflare Turnstile widget on the login page. Returns its
   viewport centre, or null if it is not (yet) rendered/visible. */
const TURNSTILE_WIDGET_JS = `(() => {
  const el = document.getElementById('cf-turnstile');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r || !r.width || !r.height) return null;
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
})()`;

const TURNSTILE_TOKEN_JS = `(() => {
  const h = document.querySelector('input[name=cf-turnstile-response], [name=cf-turnstile-response]');
  return h && h.value ? h.value : '';
})()`;

/* Click the Turnstile checkbox and wait for the hidden token to populate.
   The checkbox sits top-left inside a 300×72 widget; the clickable check box
   is ~24px from the top-left corner. Returns true on success. */
async function solveTurnstile(cdp, sessionId, waitMs) {
  try {
    const deadline = Date.now() + (waitMs || 25000);

    /* The widget is only injected after the first submit click; wait for it. */
    let rect = null;
    while (Date.now() < deadline) {
      rect = await evaluate(cdp, sessionId, TURNSTILE_WIDGET_JS);
      if (rect && rect.w > 0) break;
      await sleep(400);
    }
    if (!rect || !rect.w) return false;

    /* If a token already arrived (invisible/managed mode), nothing to do. */
    if (await evaluate(cdp, sessionId, TURNSTILE_TOKEN_JS)) return true;

    /* Click the check box near the widget's top-left corner. */
    await realClick(cdp, sessionId, rect.x + 25, rect.y + 24);

    /* Poll for the token (managed checkboxes resolve in a moment). */
    while (Date.now() < deadline) {
      if (await evaluate(cdp, sessionId, TURNSTILE_TOKEN_JS)) return true;
      await sleep(500);
    }
    return false;
  } catch (e) { return false; }
}

function httpJSON(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Bad JSON from ' + url)); }
      });
    }).on('error', reject);
  });
}

async function waitForDebugger(userDataDir, timeoutMs) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (existsSync(portFile)) {
        const line = readFileSync(portFile, 'utf8').split('\n')[0];
        const port = parseInt(line, 10);
        if (port) {
          const ver = await httpJSON('http://127.0.0.1:' + port + '/json/version').catch(() => null);
          if (ver && ver.webSocketDebuggerUrl) return ver.webSocketDebuggerUrl;
        }
      }
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('Chrome did not open a debugging port in time.');
}

async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  }, sessionId);
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails.exception || {};
    throw new Error('Page script error: ' + (d.description || r.exceptionDetails.text || 'unknown'));
  }
  return r && r.result ? r.result.value : undefined;
}

const STATE_JS = `(() => {
  let auth = '';
  try { auth = document.cookie || ''; } catch (e) {}
  const pass = document.querySelector('input[type=password]');
  const email = document.querySelector('input[type=email], input[name=email], input[name=username], input[autocomplete=email], input[autocomplete=username]');
  const hasAuth = !!auth.match(/(?:^|;)\\s*(authorization_token|auth_token)=/);
  const loginPath = /^https:\\/\\/[^/]+\\/login(\\/|$)/.test(location.href);
  const bodyText = document.body ? (document.body.innerText || '').slice(0, 2000) : '';
  const checkpoint = /security\\s+checkpoint|verifying\\s+your\\s+browser|captcha|challenge/i.test(bodyText);
  const failure = !checkpoint && /(incorrect|do not match|are\\s+not\\s+valid|wrong\\s+password|invalid\\s+(email|password|credential)|try\\s+again|too\\s+many|locked|unrecognised|unrecognized)/i.test(bodyText);
  return { hasForm: !!pass, hasEmail: !!email, hasAuth: hasAuth, loginPath: loginPath, failure: failure };
})()`;

function fillJS(selectorExpr, value) {
  return `(() => {
    const el = ${selectorExpr};
    if (!el) return false;
    const proto = (el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement).prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

const CLICK_SUBMIT_JS = `(() => {
  const picks = ['button[type=submit]', 'input[type=submit]', 'form button[type=submit]', 'form input[type=submit]'];
  for (const p of picks) { const el = document.querySelector(p); if (el && !el.disabled) { el.click(); return true; } }
  const pass = document.querySelector('input[type=password]');
  const form = pass && (pass.form || pass.closest('form'));
  if (form) { const b = form.querySelector('button'); if (b) { b.click(); return true; } }
  return false;
})()`;

const CLICK_CONTINUE_JS = `(() => {
  const email = document.querySelector('input[type=email], input[name=email], input[name=username], input[autocomplete=email]');
  const form = email && (email.form || email.closest('form'));
  if (!form) return false;
  const btn = form.querySelector('button, input[type=submit]');
  if (btn && !btn.disabled) { btn.click(); return true; }
  return false;
})()`;

const ME_JS = `(async () => {
  /* The SPA authenticates to prod-api with the auth_token it keeps in a cookie,
     sent as the X-Auth-Token header. prod-api is a different host than
     uppbeat.io, so a plain credentials:'include' fetch never carries the
     host-only cookie — we must read it from document.cookie and send it. */
  let tok = '';
  try {
    const ck = document.cookie.match(/(?:^|;\\s*)(auth_token|authorization_token)=([^;]+)/i);
    if (ck) tok = decodeURIComponent((ck[2] || '').trim());
  } catch (e) {}
  try {
    const h = { 'Accept': 'application/json' };
    if (tok) h['X-Auth-Token'] = tok;
    const r = await fetch(${JSON.stringify(ACCOUNT_PATH)}, { credentials: 'include', headers: h });
    let json = null;
    try { json = await r.json(); } catch (e) {}
    /* Top-level \`auth_token\` is NOT a login signal — Uppbeat sets it true for
       any token cookie, including one it never issued, so testing it declared
       success for signed-out guest sessions. The account lives at
       \`user.user\` and only \`user.is_authenticated\` answers the question. */
    const w = json && json.user;
    const signedIn = !!(w && (w.is_authenticated === true || (w.user && (w.user.email || w.user.id))));
    return { status: r.status, signedIn: signedIn, json: json };
  } catch (e) {
    return { status: 0, json: null, signedIn: false };
  }
})()`;

/* --- --verify mode ---------------------------------------------------------
   Re-check an already-imported session's plan by handing its cookies to a real
   Chrome and letting the browser (which passes the Vercel checkpoint) fetch
   /api/v1/me. The panel Node HTTP client is always 429'd, so the browser is
   the only client that can answer "what plan is this session".

   Usage:  echo "<cookie string>" | node uppbeat-login.mjs --verify [--timeout 60000]
   Prints { ok:true, me:{...} } or { ok:false, error:"..." }.
   ======================================================================== */

async function runVerify() {
  const args = process.argv.slice(2);
  const timeoutMs = parseInt(args[args.indexOf('--timeout') + 1], 10) || 60000;

  const cookiesText = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { resolve(data); });
    process.stdin.resume();
  });
  const pairs = String(cookiesText || '')
    .split(/[;\r\n]+/).map((s) => s.trim()).filter(Boolean)
    .map((s) => {
      const i = s.indexOf('=');
      return i > 0 ? { name: s.slice(0, i).trim(), value: s.slice(i + 1).trim() } : null;
    }).filter((p) => p && p.name && p.value);
  if (!pairs.length) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'No cookies received on STDIN to verify with.' }) + '\n');
    return 1;
  }

  const chromePath = findBrowser(browserArg());
  if (!chromePath) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'No browser found to verify with. Install Chrome/Edge/Brave/Opera/Vivaldi, or set MR_BROWSER_PATH.' }) + '\n');
    return 1;
  }

  const startedAt = Date.now();
  const remaining = Math.max(30000, timeoutMs);
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'mrupbeat-'));
  let child = null, ws = null, cdp = null, pageSession = null;

  try {
    child = spawn(chromePath, [
      '--user-data-dir=' + userDataDir,
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--disable-blink-features=AutomationControlled',
      'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
    child.on('error', () => {});

    const wsUrl = await waitForDebugger(userDataDir, Math.min(remaining, 40000));
    if (Date.now() - startedAt > remaining) throw new Error('Timed out while Chrome was starting.');

    ws = await connectWS(wsUrl, 15000);
    cdp = new CDP(ws);

    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    pageSession = attached.sessionId;

    await cdp.send('Runtime.enable', {}, pageSession);
    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Network.enable', {}, pageSession);

    /* Inject the stored session cookies so the navigation carries them. */
    for (const p of pairs) {
      for (const url of ['https://uppbeat.io', 'https://www.uppbeat.io']) {
        await cdp.send('Network.setCookie', { name: p.name, value: p.value, url, path: '/' }, pageSession).catch(() => {});
      }
    }

    await cdp.send('Page.navigate', { url: 'https://uppbeat.io/' }, pageSession);

    /* Let Chrome pass the checkpoint, then ask prod-api setup_frontend. */
    let me = { status: 0, json: null, signedIn: false };
    for (;;) {
      if (Date.now() - startedAt > remaining) break;
      me = (await evaluate(cdp, pageSession, ME_JS).catch(() => null)) || { status: 0 };
      if (me.signedIn || me.status === 401) break;
      await sleep(700);
    }
    if (me.status === 401) throw new Error('These cookies no longer log in — re-sign-in at uppbeat.io.');
    if (!me.signedIn) {
      const snippet = me.json ? String(JSON.stringify(me.json)).slice(0, 160) : '';
      const detail = 'HTTP ' + (me.status || '?') + (snippet ? ' ' + snippet : '');
      throw new Error('These cookies no longer log in — re-sign-in at uppbeat.io (setup_frontend did not authenticate: ' + detail + ').');
    }

    process.stdout.write(JSON.stringify({ ok: true, me: me.json }) + '\n');
    return 0;
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: (e && e.message) || 'Unknown error' }) + '\n');
    return 1;
  } finally {
    try { if (cdp) await cdp.send('Browser.close'); } catch (e) {}
    try { if (ws) ws.close(); } catch (e) {}
    try { if (child && typeof child.pid === 'number') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(600);
    try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 }); } catch (e) {}
  }
}

/* --- --probe mode ----------------------------------------------------------
   Discover the current Uppbeat API paths. Chrome passes the Vercel checkpoint
   (so we see real status codes, not 429s), then we fetch a list of candidate
   URLs same-origin and report each one's status + a snippet. Used when the
   panel reports 404 on a hardcoded endpoint.

   Usage:  echo '{"cookies":"...","urls":["https://uppbeat.io/api/...",...]}'
             | node uppbeat-login.mjs --probe [--timeout 60000]
   Prints { ok:true, results:[{url,status,snippet,html}] } or { ok:false,... }.
   ======================================================================== */

async function runProbe() {
  const args = process.argv.slice(2);
  const timeoutMs = parseInt(args[args.indexOf('--timeout') + 1], 10) || 60000;

  const spec = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.resume();
  });
  let input = null;
  try { input = JSON.parse(spec || '{}'); } catch (e) { input = null; }
  const urls = (input && input.urls) || [];
  if (!urls.length) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'No URLs to probe — send {"urls":[...]} on STDIN.' }) + '\n');
    return 1;
  }
  const pairs = String((input && input.cookies) || '')
    .split(/[;\r\n]+/).map((s) => s.trim()).filter(Boolean)
    .map((s) => { const i = s.indexOf('='); return i > 0 ? { name: s.slice(0, i).trim(), value: s.slice(i + 1).trim() } : null; })
    .filter((p) => p && p.name && p.value);

  const chromePath = findBrowser(browserArg());
  if (!chromePath) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'No browser found to probe with.' }) + '\n');
    return 1;
  }

  const startedAt = Date.now();
  const remaining = Math.max(30000, timeoutMs);
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'mrupbeat-'));
  let child = null, ws = null, cdp = null, pageSession = null;

  try {
    child = spawn(chromePath, [
      '--user-data-dir=' + userDataDir,
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--disable-blink-features=AutomationControlled',
      'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
    child.on('error', () => {});

    const wsUrl = await waitForDebugger(userDataDir, Math.min(remaining, 40000));
    if (Date.now() - startedAt > remaining) throw new Error('Timed out while Chrome was starting.');

    ws = await connectWS(wsUrl, 15000);
    cdp = new CDP(ws);

    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    pageSession = attached.sessionId;

    await cdp.send('Runtime.enable', {}, pageSession);
    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Network.enable', {}, pageSession);

    for (const p of pairs) {
      for (const url of ['https://uppbeat.io', 'https://www.uppbeat.io']) {
        await cdp.send('Network.setCookie', { name: p.name, value: p.value, url, path: '/' }, pageSession).catch(() => {});
      }
    }
    await cdp.send('Page.navigate', { url: 'https://uppbeat.io/' }, pageSession);

    /* Let the checkpoint clear first. */
    for (;;) {
      if (Date.now() - startedAt > remaining) break;
      const s = (await evaluate(cdp, pageSession,
        `(() => { try { return !!document.querySelector('form, nav, header'); } catch (e) { return false; } })()`).catch(() => null));
      if (s) break;
      await sleep(500);
    }

    const PROBE_JS = `(async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' } });
        const text = await r.text();
        const html = /^\\s*<\\/?[a-z!]/i.test(text);
        const snippet = html ? String(text).replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 200) : String(text).slice(0, 300);
        return { status: r.status, html: html, snippet: snippet };
      } catch (e) {
        return { status: 0, html: false, snippet: String(e && e.message || 'network error').slice(0, 200) };
      }
    })(${JSON.stringify('URLPLACE')})`;

    const results = [];
    for (const u of urls) {
      if (Date.now() - startedAt > remaining) break;
      const r = (await evaluate(cdp, pageSession, PROBE_JS.replace('URLPLACE', u.replace(/"/g, '\\"'))).catch(() => null)) ||
        { status: 0, html: false, snippet: 'eval failed' };
      results.push({ url: u, status: r.status, html: !!r.html, snippet: r.snippet });
      await sleep(250);
    }

    process.stdout.write(JSON.stringify({ ok: true, results: results }) + '\n');
    return 0;
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: (e && e.message) || 'Unknown error' }) + '\n');
    return 1;
  } finally {
    try { if (cdp) await cdp.send('Browser.close'); } catch (e) {}
    try { if (ws) ws.close(); } catch (e) {}
    try { if (child && typeof child.pid === 'number') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(600);
    try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 }); } catch (e) {}
  }
}

/* --- --capture mode --------------------------------------------------------
   Watch a page load and print the API-looking requests the SPA actually makes,
   with their response codes. This reveals the real API origin when hardcoded
   endpoints 404 (the site moved hosts/paths).

   Usage:  echo '<cookies>' | node uppbeat-login.mjs --capture <url> [--timeout 40000]
   Prints { ok:true, requests:[{url,status,type}] }.
   ======================================================================== */

async function runCapture() {
  const args = process.argv.slice(2);
  const url = args[args.indexOf('--capture') + 1] || 'https://uppbeat.io/';
  const timeoutMs = parseInt(args[args.indexOf('--timeout') + 1], 10) || 40000;

  const cookiesText = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.resume();
  });
  const pairs = String(cookiesText || '')
    .split(/[;\r\n]+/).map((s) => s.trim()).filter(Boolean)
    .map((s) => { const i = s.indexOf('='); return i > 0 ? { name: s.slice(0, i).trim(), value: s.slice(i + 1).trim() } : null; })
    .filter((p) => p && p.name && p.value);

  const chromePath = findBrowser(browserArg());
  if (!chromePath) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'No browser found to capture with.' }) + '\n');
    return 1;
  }

  const startedAt = Date.now();
  const remaining = Math.max(20000, timeoutMs);
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'mrupbeat-'));
  let child = null, ws = null, cdp = null, pageSession = null;
  const seen = new Map();
  const apiRe = /(api|graphql|graph|me|account|user|track|search|download|session|login|cookie|token|csrf)/i;

  try {
    const captured = { requests: [] };
    child = spawn(chromePath, [
      '--user-data-dir=' + userDataDir,
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--disable-blink-features=AutomationControlled',
      'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
    child.on('error', () => {});

    const wsUrl = await waitForDebugger(userDataDir, Math.min(remaining, 40000));
    if (Date.now() - startedAt > remaining) throw new Error('Timed out while Chrome was starting.');

    ws = await connectWS(wsUrl, 15000);
    cdp = new CDP(ws);

    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    pageSession = attached.sessionId;

    await cdp.send('Runtime.enable', {}, pageSession);
    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Network.enable', {}, pageSession);

    cdp.ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || m.sessionId !== pageSession) return;
      const method = m.method || '';
      const p = (m.params || {}).request || {};
      const reqUrl = p.url || '';
      if (method === 'Network.requestWillBeSent' && apiRe.test(reqUrl) && !/[./](css|js|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|avif|gif)(\?|$)/.test(reqUrl)) {
        if (!seen.has(reqUrl)) {
          seen.set(reqUrl, 1);
          captured.requests.push({
            url: reqUrl,
            method: p.method || 'GET',
            type: (p.initiator && p.initiator.type) || 'xhr',
            apiKey: (p.headers && p.headers['x-typesense-api-key']) || '',
            post: String(p.postData || '').slice(0, 1200)
          });
        }
      } else if (method === 'Network.responseReceived' && apiRe.test(reqUrl) && !/[./](css|js|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|avif)(\?|$)/.test(reqUrl)) {
        const r = m.params.response || {};
        const hit = captured.requests.find((c) => c.url === reqUrl);
        if (hit) hit.status = r.status;
      }
    });

    for (const p of pairs) {
      for (const u of ['https://uppbeat.io', 'https://www.uppbeat.io']) {
        await cdp.send('Network.setCookie', { name: p.name, value: p.value, url: u, path: '/' }, pageSession).catch(() => {});
      }
    }
    await cdp.send('Page.navigate', { url: url }, pageSession);

    /* Wait briefly, capturing any API traffic the SPA issues. */
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      if (Date.now() - startedAt > remaining) break;
      await sleep(500);
    }

    process.stdout.write(JSON.stringify({ ok: true, requests: captured }) + '\n');
    return 0;
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: (e && e.message) || 'Unknown error' }) + '\n');
    return 1;
  } finally {
    try { if (cdp) await cdp.send('Browser.close'); } catch (e) {}
    try { if (ws) ws.close(); } catch (e) {}
    try { if (child && typeof child.pid === 'number') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(600);
    try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 }); } catch (e) {}
  }
}

/* --- --whoami mode ---------------------------------------------------------
   After loading uppbeat.io with a candidate session, report whether the site
   recognises it as logged in and what cookie/localStorage names are in play.
   This tells us whether an imported session is stale (site rebuilt) vs valid.

   Usage:  echo '<cookies>' | node uppbeat-login.mjs --whoami [--timeout 40000]
   Prints { ok:true, whoami:{...} }.
   ======================================================================== */

async function runWhoami() {
  const args = process.argv.slice(2);
  const timeoutMs = parseInt(args[args.indexOf('--timeout') + 1], 10) || 40000;

  const cookiesText = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.resume();
  });
  const pairs = String(cookiesText || '')
    .split(/[;\r\n]+/).map((s) => s.trim()).filter(Boolean)
    .map((s) => { const i = s.indexOf('='); return i > 0 ? { name: s.slice(0, i).trim(), value: s.slice(i + 1).trim() } : null; })
    .filter((p) => p && p.name && p.value);

  const chromePath = findBrowser(browserArg());
  if (!chromePath) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'No browser found.' }) + '\n');
    return 1;
  }

  const startedAt = Date.now();
  const remaining = Math.max(20000, timeoutMs);
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'mrupbeat-'));
  let child = null, ws = null, cdp = null, pageSession = null;

  const WHOAMI_JS = `(() => {
    const ck = {};
    try { (document.cookie || '').split(';').forEach(function (s) { const i = s.indexOf('='); if (i > 0) ck[s.slice(0, i).trim()] = 1; }); } catch (e) {}
    const ls = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = 1; } } catch (e) {}
    let nd = null;
    try { const el = document.getElementById('__NEXT_DATA__'); if (el) nd = JSON.parse(el.textContent || 'null'); } catch (e) {}
    const text = (document.body && (document.body.innerText || '')).slice(0, 1500);
    const loggedIn = /(my downloads|my playlists|account|sign out|log out|credits|downloads\\s*\\(|subscription)/i.test(text);
    const buildId = (nd && nd.buildId) || '';
    const apiReveal = [];
    const scripts = document.querySelectorAll('script[src]');
    for (let i = 0; i < scripts.length && apiReveal.length < 6; i++) {
      const s = scripts[i].getAttribute('src') || '';
      if (/\\/_next\\/static\\//.test(s)) apiReveal.push(s);
    }
    return {
      url: location.href,
      cookieNames: Object.keys(ck),
      localStorageKeys: Object.keys(ls),
      loggedInHint: loggedIn,
      buildId: buildId,
      page: (nd && nd.page) || null,
      props: nd && nd.props && nd.props.pageProps ? Object.keys(nd.props.pageProps) : null,
      scripts: apiReveal,
      bodyText: text.slice(0, 600)
    };
  })()`;

  try {
    child = spawn(chromePath, [
      '--user-data-dir=' + userDataDir,
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--disable-blink-features=AutomationControlled',
      'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
    child.on('error', () => {});

    const wsUrl = await waitForDebugger(userDataDir, Math.min(remaining, 40000));
    if (Date.now() - startedAt > remaining) throw new Error('Timed out while Chrome was starting.');

    ws = await connectWS(wsUrl, 15000);
    cdp = new CDP(ws);

    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    pageSession = attached.sessionId;

    await cdp.send('Runtime.enable', {}, pageSession);
    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Network.enable', {}, pageSession);

    for (const p of pairs) {
      for (const url of ['https://uppbeat.io', 'https://www.uppbeat.io']) {
        await cdp.send('Network.setCookie', { name: p.name, value: p.value, url, path: '/' }, pageSession).catch(() => {});
      }
    }
    await cdp.send('Page.navigate', { url: 'https://uppbeat.io/account' }, pageSession);

    let dump = null;
    for (;;) {
      if (Date.now() - startedAt > remaining) break;
      dump = (await evaluate(cdp, pageSession, WHOAMI_JS).catch(() => null)) || null;
      if (dump && dump.url && dump.url.indexOf('uppbeat.io') !== -1 && dump.bodyText) break;
      await sleep(700);
    }

    process.stdout.write(JSON.stringify({ ok: true, whoami: dump }) + '\n');
    return 0;
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: (e && e.message) || 'Unknown error' }) + '\n');
    return 1;
  } finally {
    try { if (cdp) await cdp.send('Browser.close'); } catch (e) {}
    try { if (ws) ws.close(); } catch (e) {}
    try { if (child && typeof child.pid === 'number') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(600);
    try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 }); } catch (e) {}
  }
}

/* --- main ---------------------------------------------------------------- */

async function run() {
  const args = process.argv.slice(2);

  if (args.indexOf('--whoami') !== -1) {
    return runWhoami();
  }

  if (args.indexOf('--capture') !== -1) {
    return runCapture();
  }

  if (args.indexOf('--probe') !== -1) {
    return runProbe();
  }

  if (args.indexOf('--verify') !== -1) {
    return runVerify();
  }

  const email = String(args[args.indexOf('--email') + 1] || '').trim();
  const timeoutMs = parseInt(args[args.indexOf('--timeout') + 1], 10) || 120000;

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'Provide a valid email address (--email).' }) + '\n');
    return 1;
  }

  const password = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { resolve(String(data).split(/\r?\n/)[0] || ''); });
    process.stdin.resume();
  });
  if (!password) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'No password received on STDIN.' }) + '\n');
    return 1;
  }

  const chromePath = findBrowser(browserArg());
  if (!chromePath) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'No browser found to log in with. Install Chrome/Edge/Brave/Opera/Vivaldi, or set MR_BROWSER_PATH.' }) + '\n');
    return 1;
  }

  const startedAt = Date.now();
  const remaining = Math.max(30000, timeoutMs);
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'mrupbeat-'));
  let child = null;
  let ws = null;
  let cdp = null;
  let pageSession = null;

  try {
    child = spawn(chromePath, [
      '--user-data-dir=' + userDataDir,
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--disable-blink-features=AutomationControlled',
      'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});   // keep the pipe drained
    child.on('error', () => {});

    const wsUrl = await waitForDebugger(userDataDir, Math.min(remaining, 40000));
    if (Date.now() - startedAt > remaining) throw new Error('Timed out while Chrome was starting.');

    ws = await connectWS(wsUrl, 15000);
    cdp = new CDP(ws);

    const created = await cdp.send('Target.createTarget', { url: LOGIN_URL });
    const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    pageSession = attached.sessionId;

    await cdp.send('Runtime.enable', {}, pageSession);
    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Network.enable', {}, pageSession);

    /* 1. Wait for the login form to appear. Real Chrome auto-solves the Vercel
       checkpoint; if a manual CAPTCHA shows, the user finishes it in the window. */
    let state = null;
    for (;;) {
      if (Date.now() - startedAt > remaining) throw new Error('Timed out waiting for the login form. If a security checkpoint or CAPTCHA is open in the Chrome window, complete it manually.');
      state = (await evaluate(cdp, pageSession, STATE_JS)) || {};
      if (state.hasEmail && state.hasForm) break;
      if (state.failure) throw new Error('The login page reported a problem before I could fill it.');
      await sleep(500);
    }

    /* 2) Fill email. Multistep forms offer a password field only after "continue". */
    await evaluate(cdp, pageSession, fillJS(
      `document.querySelector('input[type=email], input[name=email], input[name=username], input[autocomplete=email]')`,
      email));
    await sleep(400);
    let hasPass = state.hasForm;
    if (!hasPass) {
      await evaluate(cdp, pageSession, CLICK_CONTINUE_JS);
      const passStart = Date.now();
      for (;;) {
        if (Date.now() - passStart > 12000) break;
        await sleep(400);
        const s = (await evaluate(cdp, pageSession, STATE_JS)) || {};
        if (s.hasForm) { hasPass = true; break; }
        if (s.failure) throw new Error('The login form reported a problem while I was filling it.');
      }
    }

    /* 3) Fill password and submit. */
    await evaluate(cdp, pageSession, fillJS(`document.querySelector('input[type=password]')`, password));
    await sleep(300);

    /* Uppbeat gates login behind a Cloudflare Turnstile checkbox. The widget is
       only injected into the DOM after the first submit click, and its hidden
       cf-turnstile-response token must be populated or the form will never
       submit. We click submit once to reveal the widget, solve it (a single
       real mouse click on the check box — no user input needed), then click
       submit again to actually log in. */
    await evaluate(cdp, pageSession, CLICK_SUBMIT_JS);
    const solved = await solveTurnstile(cdp, pageSession, 25000);
    trace('turnstile solved=', solved);
    if (solved) {
      await sleep(300);
      await evaluate(cdp, pageSession, CLICK_SUBMIT_JS);
    }

    /* 4) Wait for the login to stick: setup_frontend answering signedIn=true
       is definitive (ME_JS reads user.is_authenticated, the only field that
       distinguishes an account from a guest token). */
    let me = null;
    for (;;) {
      if (Date.now() - startedAt > remaining) break;
      me = (await evaluate(cdp, pageSession, ME_JS).catch(() => null)) || { status: 0, signedIn: false };
      if (me.signedIn) break;
      const s = (await evaluate(cdp, pageSession, STATE_JS).catch(() => null)) || {};
      if (s.failure) break;
      await sleep(700);
    }

    /* 4b) If it still did not stick, one more submit pass after solving (covers
       first-click validation hiccups). */
    if (!me.signedIn) {
      if (await solveTurnstile(cdp, pageSession, 12000)) {
        await sleep(300);
        await evaluate(cdp, pageSession, CLICK_SUBMIT_JS);
        for (;;) {
          if (Date.now() - startedAt > remaining) break;
          me = (await evaluate(cdp, pageSession, ME_JS).catch(() => null)) || { status: 0, signedIn: false };
          if (me.signedIn) break;
          await sleep(700);
        }
      }
    }

    /* 5) Harvest cookies (uppbeat.io + the prod-api subdomain share .uppbeat.io
       session cookies, so filtering on the registrable domain catches both). */
    const cookiesRes = await cdp.send('Network.getAllCookies', {}, pageSession);
    const all = ((cookiesRes && cookiesRes.cookies) || []).filter((c) =>
      String(c.domain || '').replace(/^\./, '').indexOf('uppbeat.io') !== -1 ||
      (c.url || '').indexOf('uppbeat.io') !== -1);
    const cookieStr = all.map((c) => c.name + '=' + c.value).join('; ');

    if (!cookieStr || !/(authorization_token|auth_token|session|authorization)/i.test(cookieStr)) {
      throw new Error('Chrome logged in but exported no session cookie. Check the Chrome window — the login may not have completed.');
    }
    if (!me || !me.signedIn) {
      me = (await evaluate(cdp, pageSession, ME_JS).catch(() => null)) || { status: 0, signedIn: false };
    }

    process.stdout.write(JSON.stringify({
      ok: true,
      cookies: cookieStr,
      me: (me && me.json) || null
    }) + '\n');
    return 0;
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: (e && e.message) || 'Unknown error' }) + '\n');
    return 1;
  } finally {
    try { if (cdp) await cdp.send('Browser.close'); } catch (e) {}
    try { if (ws) ws.close(); } catch (e) {}
    try { if (child && typeof child.pid === 'number') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' }); } catch (e) {}
    await sleep(600);
    try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 300 }); } catch (e) {}
  }
}

run().then((code) => process.exit(code || 0)).catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: (e && e.message) || 'Fatal' }) + '\n');
  process.exit(1);
});