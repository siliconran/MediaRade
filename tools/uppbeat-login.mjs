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
const API_BASE = 'https://prod-api.uppbeat.io';
/* The rebuilt SPA serves account/plan state from /api/setup_frontend. A real
   browser shares the .uppbeat.io session cookies with the prod-api subdomain,
   so a plain credentials:'include' fetch is authenticated. The body (not the
   HTTP status) tells us whether the session is valid: `auth_token` truthy +
   `user.is_authenticated` = signed in. */
const ACCOUNT_PATH = API_BASE + '/api/setup_frontend?fev=uppbeat-next@1.1.18';

const CHROME_CANDIDATES = [
  process.env.MR_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env['ProgramFiles'] ? (process.env['ProgramFiles'] + '\\Google\\Chrome\\Application\\chrome.exe') : null,
  process.env['ProgramFiles(x86)'] ? (process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe') : null,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

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
  try {
    const r = await fetch(${JSON.stringify(ACCOUNT_PATH)}, { credentials: 'include', headers: { 'Accept': 'application/json' } });
    let json = null;
    try { json = await r.json(); } catch (e) {}
    const signedIn = !!(json && (json.auth_token || (json.user && json.user.is_authenticated)));
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

  const chromePath = findChrome();
  if (!chromePath) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'No Chrome or Edge found to verify with. Install Chrome, or set MR_CHROME.' }) + '\n');
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
    if (!me.signedIn) throw new Error('These cookies no longer log in — re-sign-in at uppbeat.io (setup_frontend did not authenticate).');

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

  const chromePath = findChrome();
  if (!chromePath) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'No Chrome or Edge found to probe with.' }) + '\n');
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

  const chromePath = findChrome();
  if (!chromePath) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'No Chrome or Edge found to capture with.' }) + '\n');
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

  const chromePath = findChrome();
  if (!chromePath) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'No Chrome or Edge found.' }) + '\n');
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

  const chromePath = findChrome();
  if (!chromePath) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'No Chrome or Edge found to log in with. Install Chrome, or set MR_CHROME.' }) + '\n');
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
    await evaluate(cdp, pageSession, CLICK_SUBMIT_JS);

    /* 4) Wait for the login to stick: setup_frontend answering signedIn=true
       is definitive (the body carries auth_token / user.is_authenticated). */
    let me = null;
    for (;;) {
      if (Date.now() - startedAt > remaining) break;
      me = (await evaluate(cdp, pageSession, ME_JS).catch(() => null)) || { status: 0, signedIn: false };
      if (me.signedIn) break;
      const s = (await evaluate(cdp, pageSession, STATE_JS).catch(() => null)) || {};
      if (s.failure) break;
      await sleep(700);
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