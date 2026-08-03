/* =============================================================================
   views/uppbeat.jsx — Uppbeat music browser, sign-in and download
   MediaRade by rad1x
   ========================================================================== */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import Bus, { state } from '../core/bus.js';
import Config from '../core/config.js';
import Library from '../core/library.js';
import Ledger from '../core/ledger.js';
import Paths from '../core/paths.js';
import Uppbeat from '../core/uppbeat.js';
import U from '../core/util.js';
import { CEP } from '../core/cep.js';
import DnD from '../ui/dragdrop.js';
import Place from '../ui/place.js';
import Modal from '../ui/modal.js';
import Toast from '../ui/toast.js';
import { Badge, Btn, Chip, Empty, Progress } from '../ui/components.jsx';

const GENRE_PRESETS = [
  'cinematic', 'lofi', 'ambient', 'corporate', 'hip hop', 'rock',
  'electronic', 'acoustic', 'upbeat', 'emotional', 'trailer', 'vlog'
];

export function UppbeatView() {
  const [results, setResults] = createSignal([]);
  const [searching, setSearching] = createSignal(false);
  const [error, setError] = createSignal(null);
  const [signedIn, setSignedIn] = createSignal(false);
  const [plan, setPlan] = createSignal('free');
  const [planError, setPlanError] = createSignal(null);
  const [busy, setBusy] = createSignal(null);      // trackId currently downloading
  const [progress, setProgress] = createSignal(0);
  const [playing, setPlaying] = createSignal(null);
  const [freeOnly, setFreeOnly] = createSignal(false);    // hide premium tracks from results

  let input, audioEl;

  function syncSession() {
    const s = Uppbeat.session();
    setSignedIn(!!s.signedIn);
    setPlan(s.plan || 'free');
    setPlanError(s.planError || null);
  }

  onMount(function () {
    Uppbeat.loadSession();
    syncSession();
    const last = Config.get('uppbeatLastQuery');
    if (last && input) input.value = last;
  });

  const off = Bus.on('uppbeat:session', syncSession);
  onCleanup(function () {
    off();
    if (audioEl) { try { audioEl.pause(); } catch (e) {} }
  });

  const premium = createMemo(function () {
    const p = String(plan() || 'free').toLowerCase();
    return signedIn() && p !== 'free' && p !== 'none';
  });

  /** Results after the Free-only filter. */
  const shown = createMemo(function () {
    const list = results();
    if (!freeOnly()) return list;
    return list.filter(function (t) { return !t.premium; });
  });

  /* --- session ------------------------------------------------------------ */

  /** A dedicated sign-in popup: shows the login URL, a one-click import, and a
      manual cookie-paste escape hatch — so it works no matter which browser is
      used (Chrome/Edge v127+ refuse to share cookies while running; portable
      forks like r3dfox may not resolve). No password ever reaches MediaRade. */
  function openSignInPopup() {
    const loginUrl = 'https://uppbeat.io/login';

    const status = U.el('div', { class: 'ps2-caption',
      style: { marginTop: '8px', minHeight: '16px' } });
    const setStatus = function (msg, tone) {
      status.textContent = msg || '';
      status.style.color = tone === 'err' ? 'var(--ps2-crit)'
        : tone === 'ok' ? 'var(--ps2-ok)' : 'var(--ps2-text-tertiary)';
    };

    const importBtn = U.el('button', { class: 'ps2-btn ps2-btn--sm ps2-btn--primary',
      text: "I've signed in — Import session" });
    const withSession = function (s) {
      Modal.close();
      syncSession();
      const who = (s.account && (s.account.name || s.account.email)) || 'Session imported';
      if (s.planError) {
        Toast.err('Signed in — plan check failed', who + ' — ' + s.planError +
          (s.plan === 'free' ? ' Tick "this account is paid" if this is a paid plan.' : ''));
      } else {
        Toast.ok('Signed in to Uppbeat', who + ' — plan: ' + (s.plan || 'free') +
          (s.browser ? ' (via ' + s.browser + ')' : ''));
      }
      if (input && input.value.trim()) doSearch();
    };

    importBtn.addEventListener('click', function () {
      importBtn.disabled = true;
      setStatus('Reading cookies from your browser…', '');
      Uppbeat.importNow().then(function (s) {
        importBtn.disabled = false;
        setStatus('Session imported.', 'ok');
        withSession(s);
      }).catch(function (e) {
        importBtn.disabled = false;
        setStatus('Could not read your browser cookies: ' + e.message, 'err');
      });
    });

    /* Dedicated field for the one cookie that carries the login. */
    const tokenIn = U.el('input', { class: 'ps2-input', type: 'text',
      placeholder: 'the auth_token / authorization_token value',
      style: { width: '100%', marginTop: '8px', fontFamily: 'var(--ps2-font-mono)', fontSize: '10px' } });
    const tokenBtn = U.el('button', { class: 'ps2-btn ps2-btn--sm ps2-btn--primary',
      text: 'Use token', title: 'For when the browser import can\'t read cookies — paste the auth_token or authorization_token value from Cookie Editor or DevTools',
      style: { marginTop: '6px' } });
    tokenBtn.addEventListener('click', function () {
      try {
        Uppbeat.setAuthToken(tokenIn.value).then(withSession);
      } catch (e) {
        setStatus('Could not use that token: ' + e.message, 'err');
      }
    });

    const manualText = U.el('textarea', {
      class: 'ps2-input', rows: 3,
      placeholder: 'or paste the whole Cookie header / Cookie-Editor export here',
      style: { width: '100%', marginTop: '8px', fontFamily: 'var(--ps2-font-mono)', fontSize: '10px' }
    });
    const manualBtn = U.el('button', { class: 'ps2-btn ps2-btn--sm',
      text: 'Use this Cookie header', style: { marginTop: '6px' } });

    manualBtn.addEventListener('click', function () {
      try {
        Uppbeat.setCookiesManually(manualText.value).then(withSession);
      } catch (e) {
        setStatus('That cookie was not accepted: ' + e.message, 'err');
      }
    });

    /* Manual plan override — last-ditch fix for the "free on a paid account"
       case, so the credit banner stays off and premium tracks resolve. */
    const forcePlanBtn = U.el('label', { class: 'ps2-check', title: 'Skip plan auto-detection and treat this account as paid' }, [
      U.el('input', { type: 'checkbox' }),
      U.el('span', { text: 'This account is paid (Creator / Pro) — don\u2019t auto-detect plan' })
    ]);
    forcePlanBtn.addEventListener('change', function () {
      const on = forcePlanBtn.querySelector('input').checked;
      if (on) {
        Uppbeat.setPlan('creator');
        withSession(Uppbeat.session());
        setStatus('Plan forced to paid (Creator). Premium tracks are unlocked.', 'ok', '');
      } else {
        Uppbeat.setPlan('redetect').then(withSession);
        setStatus('Plan override cleared — re-detecting from the account.', '', '');
      }
    });

    /* Shows exactly what the account endpoint returns, so a wrong path or a
       session that isn't accepted is visible instead of "free". */
    const diagnoseBtn = U.el('button', { class: 'ps2-btn ps2-btn--sm ps2-btn--ghost',
      text: 'Diagnose account & plan', style: { marginTop: '6px' } });
    diagnoseBtn.addEventListener('click', function () {
      diagnoseBtn.disabled = true;
      setStatus('Contacting Uppbeat…', '');
      Uppbeat.diagnose().then(function (d) {
        diagnoseBtn.disabled = false;
        const head = 'Account endpoint answered HTTP ' + d.status +
          (d.server ? ' (' + d.server + ')' : '') +
          ' · detected plan: ' + (d.detectedPlan || 'none') +
          ' · cookies sent: ' + (d.cookieNames || 'none');
        setStatus(head + '. Full response written to the Log tab.', d.status === 200 ? 'ok' : 'err');
        try {
          Paths.log('uppbeat diagnose: endpoint=' + d.endpoint + ' status=' + d.status +
            ' server=' + d.server + ' retry-after=' + (d.retryAfter || 'none') +
            ' cookies=' + d.cookieNames + ' plan=' + d.detectedPlan + ' body=' + d.body);
        } catch (e) {}
      }).catch(function (e) {
        diagnoseBtn.disabled = false;
        setStatus('Diagnose failed: ' + e.message, 'err');
      });
    });

    /* Pull out a real browser window (the system default) so signing in is one
       jump away, and the session can be imported straight after. */
    Uppbeat.openSignIn();

    Modal.open({
      title: 'Sign in to Uppbeat',
      body: U.el('div', { class: 'ps2-col-gap' }, [
        U.el('div', { class: 'ps2-caption', html:
          '<b>1.</b> A browser window has opened — sign in at uppbeat.io there. MediaRade never sees your password. ' +
          'Then return here and click <b>Import session</b>.' }),
        U.el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, [
          U.el('div', { class: 'mr-attrib', style: { margin: '6px 0', userSelect: 'text', flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis' }, text: loginUrl }),
          U.el('button', { class: 'ps2-btn ps2-btn--sm', text: 'Open', title: 'Open the login page',
            onclick: function () { Uppbeat.openSignIn(); } }),
          U.el('button', { class: 'ps2-btn ps2-btn--sm ps2-btn--ghost', text: 'Copy URL',
            onclick: function () { U.copy(loginUrl); } })
        ]),
        U.el('div', { class: 'ps2-row-gap ps2-wrap' }, [ importBtn ]),
        status,
        U.el('hr', { class: 'ps2-hr' }),
        U.el('div', { class: 'ps2-caption', html:
          '<b>Stuck?</b> Chrome and Edge (v127+) lock their cookies while running, and portable browsers like ' +
          'r3dfox need their profile folder set in <b>Setup › Uppbeat</b>. Then either:' }),
        U.el('div', { class: 'ps2-col-gap', style: { marginTop: '6px' } }, [
          tokenIn,
          U.el('div', {}, [ tokenBtn ]),
          U.el('div', { class: 'ps2-caption', html:
            'In Cookie Editor (or DevTools → Application → Cookies → <code>uppbeat.io</code>), copy the <b>value</b> of <code>auth_token</code> or <code>authorization_token</code> into the box above — the panel sends it under both names so either one works. If it still 429s, also tick <b>This account is paid</b> below.' }),
          U.el('hr', { class: 'ps2-hr' }),
          manualText,
          U.el('div', {}, [ manualBtn ]),
          U.el('hr', { class: 'ps2-hr' }),
          forcePlanBtn,
          diagnoseBtn,
          U.el('div', { class: 'ps2-caption', html:
            '<b>Plan still reads "free"?</b> If Uppbeat won\u2019t report the account level, tick the box above to manually mark it paid (Creator/Pro) so premium tracks unlock. Use <b>Diagnose</b> to see exactly what Uppbeat returns (full response is written to the Log tab).' })
        ])
      ]),
      buttons: [{ label: 'Close', run: function () { Modal.close(); } }]
    });
  }

  function refreshSession() {
    Uppbeat.importNow().then(function (s) {
      syncSession();
      Toast.ok('Session refreshed', 'Imported via ' + (s.browser || 'browser') + ' — plan: ' + (s.plan || 'free'));
    }).catch(function (e) {
      Toast.err('Could not refresh', e.message);
    });
  }

  function signOut() {
    Uppbeat.clearSession();
    syncSession();
    setResults([]);
    Toast.info('Signed out', 'The stored Uppbeat session was cleared.');
  }

  function checkPlan() {
    Uppbeat.me().then(function (s) {
      syncSession();
      if (s.planError) Toast.err('Plan check failed', s.planError);
      else Toast.ok('Plan checked', 'account: ' + (s.plan || 'free') +
        ' · premium ' + (Uppbeat.isPremium() ? 'ON' : 'off'));
    });
  }

  /* --- search -------------------------------------------------------------- */

  function doSearch(q) {
    const query = (q !== undefined ? q : input.value).trim();
    if (!query) { Toast.info('Nothing to search', 'Type a mood, genre or track name.'); return; }
    if (input) input.value = query;
    Config.set('uppbeatLastQuery', query);

    if (!signedIn()) {
      setError('Sign in first — Uppbeat gates the catalogue and every download on your account.');
      return;
    }

    setSearching(true);
    setError(null);
    Uppbeat.search(query).then(function (tracks) {
      setSearching(false);
      setResults(tracks);
      if (!tracks.length) setError('Uppbeat returned no tracks for "' + query + '".');
    }).catch(function (e) {
      setSearching(false);
      setResults([]);
      setError(e.message);
    });
  }

/* --- preview -------------------------------------------------------------- */

  function togglePlay(t) {
    if (!t.preview) { Toast.info('No preview', 'Uppbeat did not supply a preview URL for this track.'); return; }
    if (playing() === t.id) {
      try { audioEl.pause(); } catch (e) {}
      setPlaying(null);
      return;
    }
    if (!audioEl) audioEl = new Audio();
    audioEl.src = t.preview;
    audioEl.play().then(function () { setPlaying(t.id); })
      .catch(function (e) { Toast.err('Preview failed', e.message); });
    audioEl.onended = function () { setPlaying(null); };
  }

  /* --- download ------------------------------------------------------------- */

  function download(t) {
    if (busy()) { Toast.info('Busy', 'One Uppbeat download at a time.'); return; }
    setBusy(t.id);
    setProgress(0);

    const report = Uppbeat.report(t);

    Uppbeat.download(t, function (p) {
      if (p.percent != null) setProgress(p.percent);
    }).then(function (res) {
      setBusy(null);
      finishDownload(res.file, t, report);
    }).catch(function (e) {
      setBusy(null);
      Toast.err('Uppbeat download failed', e.message);
    });
  }

  /** Shared tail for both direct and assisted downloads. */
  function finishDownload(file, track, report) {
    try {
      Ledger.writeSidecars(file, report, { downloadedAt: new Date().toISOString(), kind: 'audio', provider: 'uppbeat' });
      Ledger.appendCredits(report, file);
      Ledger.record({
        event: 'download_complete', provider: 'uppbeat',
        videoId: track.id, title: track.title, channel: track.artist,
        kind: 'audio', file: file, verdict: report.level,
        requiresAttribution: report.requiresAttribution,
        attribution: report.attribution.short
      });
    } catch (e) { Paths.log('uppbeat sidecar failed: ' + e.message); }

    const entry = Library.add({
      videoId: track.id,
      title: track.title,
      channel: track.artist,
      kind: 'audio',
      provider: 'uppbeat',
      file: file,
      files: [file],
      thumb: track.artwork || null,
      report: report,
      quality: 'uppbeat',
      downloadedAt: Date.now()
    });

    Toast.show({
      kind: report.requiresAttribution ? 'warn' : 'ok',
      title: report.requiresAttribution ? 'Downloaded — credit required' : 'Downloaded',
      text: track.title + ' by ' + track.artist +
            (report.requiresAttribution ? '. Copy the credit before you publish.' : ''),
      duration: 9000,
      action: {
        label: 'Copy credit',
        run: function () {
          U.copy(report.attribution.credits);
          Toast.ok('Copied', 'Uppbeat credit is on the clipboard.');
        }
      }
    });

    if (Config.get('autoImport')) Place.toBin({ file: file, title: track.title, report: report, entry: entry });
  }

  /* --- assisted ingest ------------------------------------------------------- */

  function ingestPicker() {
    const found = Uppbeat.scanNew(Date.now() - 1000 * 60 * 60 * 6);   // last 6 hours
    if (!found.length) {
      Toast.warn('Nothing new found',
        'No audio downloaded in the last 6 hours in ' + (Uppbeat.watchDir() || 'your Downloads folder') + '.');
      return;
    }

    let chosen = found[0];
    const list = U.el('div', { class: 'ps2-list', style: { marginBottom: '12px' } },
      found.slice(0, 12).map(function (f, i) {
        const row = U.el('div', { class: 'ps2-row' + (i === 0 ? ' is-selected' : '') }, [
          U.el('div', { class: 'ps2-row__main' }, [
            U.el('div', { class: 'ps2-row__title', text: f.name }),
            U.el('div', { class: 'ps2-row__sub', text: U.bytes(f.size) + ' · ' + new Date(f.mtime).toLocaleString() })
          ])
        ]);
        row.addEventListener('click', function () {
          chosen = f;
          U.$$('.ps2-row', list).forEach(function (n) { n.classList.remove('is-selected'); });
          row.classList.add('is-selected');
          const g = Uppbeat.guessFromFilename(f.name);
          titleIn.value = g.title;
          artistIn.value = g.artist;
        });
        return row;
      }));

    const guess = Uppbeat.guessFromFilename(found[0].name);
    const titleIn = U.el('input', { class: 'ps2-input', value: guess.title, placeholder: 'Track title' });
    const artistIn = U.el('input', { class: 'ps2-input', value: guess.artist, placeholder: 'Artist name' });
    const pageIn = U.el('input', { class: 'ps2-input', placeholder: 'https://uppbeat.io/t/… (optional, used in the credit)' });

    Modal.open({
      title: 'Ingest an Uppbeat download',
      body: U.el('div', { class: 'ps2-col-gap' }, [
        U.el('div', { class: 'mr-claimwarn' }, [
          U.el('span', { text: 'ⓘ' }),
          U.el('span', {
            html: 'Pick the file you just downloaded from uppbeat.io. Confirm the artist and title — ' +
                  'those go into the credit that <b>must</b> appear in your video description on the free plan.'
          })
        ]),
        list,
        U.el('div', { class: 'mr-field' }, [U.el('span', { class: 'mr-field__label', text: 'Track title' }), titleIn]),
        U.el('div', { class: 'mr-field' }, [U.el('span', { class: 'mr-field__label', text: 'Artist' }), artistIn]),
        U.el('div', { class: 'mr-field' }, [U.el('span', { class: 'mr-field__label', text: 'Track page' }), pageIn])
      ]),
      buttons: [
        { label: 'Cancel', run: function () { Modal.close(); } },
        {
          label: 'Ingest',
          variant: 'primary',
          run: function () {
            Modal.close();
            try {
              const res = Uppbeat.ingest(chosen.file, {
                title: titleIn.value.trim(), artist: artistIn.value.trim(), page: pageIn.value.trim() || undefined
              });
              finishDownload(res.file, res.track, res.report);
            } catch (e) { Toast.err('Ingest failed', e.message); }
          }
        }
      ]
    });
  }

  /* --- render ---------------------------------------------------------------- */

  return (
    <>
      <div class="mr-view__toolbar">
        <div class="mr-searchbar">
          <input ref={input} class="ps2-input" type="text"
            placeholder="Search Uppbeat — mood, genre, track or artist…"
            onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }} />
          <Btn variant="primary" label="Search" onClick={() => doSearch()} />
        </div>

        <div class="mr-filters" style={{ 'margin-bottom': '6px' }}>
          <div class="mr-filters__group">
            <span class="mr-filters__label">Account</span>
            <Show
              when={signedIn()}
              fallback={<Badge text="not signed in" kind="mute" />}
            >
              <Badge text={premium() ? 'premium · ' + plan() : 'free plan'} kind={premium() ? 'ok' : 'warn'}
                title={planError() ? planError() : ''} />
            </Show>

            <Show when={!signedIn()}>
              <Btn size="sm" variant="primary" label="Sign in"
                title="Opens a popup with the login URL and a one-click session import — plus a manual cookie-paste fallback. Your password never reaches this panel."
                onClick={openSignInPopup} />
            </Show>

            <Show when={signedIn()}>
              <Btn size="sm" label="Refresh" title="Re-import the session and re-check your plan"
                onClick={refreshSession} />
              <Btn size="sm" variant="ghost" label="Check plan" title="Re-run the account/plan check now (use after a rate-limit reset)"
                onClick={checkPlan} />
              <Btn size="sm" variant="ghost" label="Sign out" onClick={signOut} />
            </Show>
          </div>

          <div class="mr-filters__group">
            <Chip label="Free only"
              title="Show only tracks covered by the free plan (hide premium tracks)"
              on={freeOnly()} onChange={(on) => setFreeOnly(on)} />
            <Btn size="sm" variant="ghost" label="Open uppbeat.io"
              onClick={() => Uppbeat.openSite('/browse/music')} />
            <Btn size="sm" variant="ghost" label="Ingest a file"
              title="Fallback: add a track you downloaded from the site yourself, with its credit"
              onClick={ingestPicker} />
          </div>
        </div>

        <div class="mr-presets">
          <For each={GENRE_PRESETS}>
            {(g) => <button class="ps2-chip" onClick={() => doSearch(g)}>{g}</button>}
          </For>
        </div>

        {/* the credit rule, stated up front */}
        <div class={'mr-claimwarn' + (premium() ? ' mr-claimwarn--ok' : '')}>
          <span>{premium() ? '✓' : '⚠'}</span>
          <Show
            when={!premium()}
            fallback={
              <span innerHTML={
                '<b>Premium plan detected.</b> Your plan widens catalogue access and download limits. ' +
                'Check your plan\'s scope before using a track in paid advertising or for a client — ' +
                'MediaRade still writes the credit and the licence record with every download.'} />
            }
          >
            <span innerHTML={
              '<b>Free plan: you must credit the artist.</b> Every free Uppbeat download comes with a credit that has ' +
              'to appear wherever the track is used — normally the video description. That credit is what tells ' +
              'YouTube the track is licensed to you; <b>without it the licence does not apply and the track can ' +
              'still be claimed.</b> Each track needs its own credit, in every video it appears in. ' +
              'MediaRade writes it to <code>attribution.txt</code> and <code>CREDITS.md</code>, and every ' +
              'download gives you a <b>Copy credit</b> button.'} />
          </Show>
        </div>
      </div>

      <div class="mr-view__body">
        <Show when={searching()}>
          <div style={{ padding: '4px 0 14px' }}>
            <Progress indeterminate />
            <div class="ps2-caption" style={{ 'margin-top': '8px', 'text-align': 'center' }}>Searching Uppbeat…</div>
          </div>
        </Show>

        <Show when={!searching() && error()}>
          <div class="mr-claimwarn" style={{ 'margin-bottom': '12px' }}>
            <span>⚠</span><span>{error()}</span>
          </div>
        </Show>

        <Show when={!searching() && !signedIn() && !results().length && !error()}>
          <Empty
            title="Sign in to Uppbeat"
            hint={
              'Press <b>Sign in</b> for a popup with the uppbeat.io login URL. Sign in there as normal — ' +
              'the panel never sees your password — then click <b>Import session</b>. If your browser cannot ' +
              'share its cookies, the popup also accepts a pasted session cookie from DevTools.'}
            action={<Btn variant="primary" label="Sign in" onClick={openSignInPopup} />}
          />
        </Show>

        <Show when={!searching() && signedIn() && !results().length && !error()}>
          <Empty title="Search Uppbeat"
            hint={signedIn()
              ? 'Type a mood or genre above. Downloads land in <code>Downloads\\Audio\\Uppbeat</code>.'
              : 'Sign in and import your session first — the catalogue and downloads are gated on your account.'} />
        </Show>

        <Show when={results().length > 0}>
          <Show when={freeOnly() && results().some((t) => t.premium)}>
            <div class="ps2-caption" style={{ padding: '0 2px 8px', color: 'var(--ps2-text-tertiary)' }}>
              Hiding {results().filter((t) => t.premium).length} premium track{results().filter((t) => t.premium).length === 1 ? '' : 's'} —
              turn off “Free only” to see them.
            </div>
          </Show>
          <div class="mr-results">
            <For each={shown()}>
              {(t) => (
                <TrackCard
                  t={t}
                  premium={premium()}
                  playing={playing() === t.id}
                  busy={busy() === t.id}
                  progress={progress()}
                  onPlay={() => togglePlay(t)}
                  onDownload={() => download(t)}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </>
  );
}

/* --- one track ------------------------------------------------------------- */

function TrackCard(props) {
  const t = () => props.t;

  const local = createMemo(function () {
    return state.libraryItems.filter(function (i) {
      return i.provider === 'uppbeat' && i.videoId === t().id;
    })[0] || null;
  });

  function copyCredit() {
    U.copy(Uppbeat.credit(t()).credits);
    Toast.ok('Copied', 'Uppbeat credit is on the clipboard — paste it into your video description.');
  }

  const payload = () => {
    const e = local();
    if (!e) return null;
    return {
      kind: 'audio', title: e.title, file: e.file, nodeId: e.nodeId || null,
      report: e.report, thumb: e.thumb, entry: e
    };
  };

  return (
    <div class="mr-card" data-tier={props.premium ? 'LOW' : 'MODERATE'}>
      <div class="mr-card__thumb mr-card__thumb--audio"
        style={t().artwork ? { 'background-image': 'url("' + t().artwork + '")' } : {}}
        onClick={props.onPlay}>
        <div class="mr-card__playbtn">{props.playing ? '❚❚' : '▶'}</div>
        {t().duration ? <span class="mr-card__dur">{U.hhmmss(t().duration)}</span> : null}
      </div>

      <div class="mr-card__body">
        <div class="mr-card__title" title={t().title}>{t().title}</div>
        <div class="mr-card__meta">
          <span class="ps2-truncate">{t().artist}</span>
          {t().bpm ? <span>{t().bpm + ' BPM'}</span> : null}
          {t().genres.length ? <span>{t().genres.slice(0, 2).join(', ')}</span> : null}
        </div>

        <div class="mr-card__tags">
          <Badge text={t().premium ? 'PREMIUM' : 'FREE'}
            kind={t().premium ? (props.premium ? 'ok' : 'crit') : 'ok'}
            title={t().premium
              ? 'Premium track — covered only on a paid Uppbeat plan'
              : 'Free track — covered by every plan'} />
          {props.premium
            ? null
            : (t().premium
              ? <Badge text="not on free plan" kind="crit" title="Needs a paid Uppbeat plan to download" />
              : <Badge text="credit required" kind="warn" title="Free downloads must credit the artist" />)}
          {local() ? <Badge text="downloaded" kind="ok" /> : null}
        </div>

        <Show when={props.busy}>
          <Progress percent={props.progress} />
        </Show>

        <div class="mr-card__actions">
          <Btn size="sm" label={props.playing ? 'Pause' : 'Preview'} onClick={props.onPlay} />

          <Show
            when={!local()}
            fallback={
              <>
                <Btn size="sm" variant="primary" label="Place"
                  ref={(el) => DnD.native(el, payload)}
                  title="Insert at the playhead — or drag this straight onto Premiere's timeline"
                  onClick={() => Place.quick(payload())} />
                <Btn size="sm" label="⤴" title="Reveal in Explorer"
                  onClick={() => CEP.revealInExplorer(local().file)} />
              </>
            }
          >
            <Btn size="sm" variant="primary" label={props.busy ? 'Downloading…' : 'Download'}
              disabled={props.busy} onClick={props.onDownload} />
          </Show>

          {/* the credit is one click away from every track, always */}
          <Btn size="sm" label="Copy credit"
            title="Copy the Uppbeat credit for this track — paste it into your video description"
            onClick={copyCredit} />

          <Btn size="sm" variant="ghost" label="↗" title="Open this track on uppbeat.io"
            onClick={() => CEP.openInBrowser(t().page)} />
        </div>
      </div>
    </div>
  );
}

export default UppbeatView;
