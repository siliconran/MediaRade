/* =============================================================================
   components.jsx — shared Solid components (replaces legacy js/ui/components.js)
   MediaRade by siliconran
   ========================================================================== */
import { For } from 'solid-js';
import U from '../core/util.js';
import License from '../core/license.js';
import Toast from './toast.js';

/* --- primitives --------------------------------------------------------- */

export function Badge(props) {
  return (
    <span class={'ps2-badge ps2-badge--' + (props.kind || 'mute')}>
      {props.dot !== false && <i class="ps2-badge__dot" />}
      <span>{props.text}</span>
    </span>
  );
}

export function Chip(props) {
  let node;
  return (
    <button
      ref={node}
      class={'ps2-chip' + (props.on ? ' is-on' : '') + (props.locked ? ' is-locked' : '')}
      title={props.title || ''}
      onClick={(e) => {
        if (!props.locked && props.onChange) props.onChange(!props.on, node);
      }}
    >
      {props.icon ? <span>{props.icon}</span> : null}
      <span>{props.label}</span>
    </button>
  );
}

export function Btn(props) {
  return (
    <button
      ref={(el) => props.ref && props.ref(el)}
      class={'ps2-btn' +
        (props.variant ? ' ps2-btn--' + props.variant : '') +
        (props.size ? ' ps2-btn--' + props.size : '') +
        (props.block ? ' ps2-btn--block' : '') +
        (props.active ? ' is-active' : '')}
      title={props.title || ''}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.icon ? <span>{props.icon}</span> : null}
      <span>{props.label}</span>
    </button>
  );
}

export function Switch(props) {
  return (
    <label class={'ps2-switch' + (props.on ? ' is-on' : '')}
      onClick={() => props.onChange && props.onChange(!props.on)}>
      <span class="ps2-switch__track"><span class="ps2-switch__thumb" /></span>
      <span class="ps2-switch__text">{props.label}</span>
    </label>
  );
}

export function Check(props) {
  return (
    <label class={'ps2-check' + (props.on ? ' is-on' : '')}
      onClick={() => props.onChange && props.onChange(!props.on)}>
      <span class="ps2-check__box" />
      <span>{props.label}</span>
    </label>
  );
}

export function Select(props) {
  let sel;
  return (
    <select
      ref={sel}
      class="ps2-select"
      title={props.title || ''}
      disabled={props.disabled}
      onChange={() => props.onChange && props.onChange(sel.value)}
    >
      <For each={props.options}>
        {(o) => {
          const v = typeof o === 'string' ? o : o.value;
          const l = typeof o === 'string' ? o : o.label;
          return <option value={v} selected={String(v) === String(props.value)}>{l}</option>;
        }}
      </For>
    </select>
  );
}

export function Field(props) {
  return (
    <div class="mr-field">
      <span class="mr-field__label">{props.label}</span>
      {props.children}
    </div>
  );
}

export function Section(props) {
  return (
    <div class="mr-section">
      <div class="mr-section__title">
        <span>{props.title}</span>
        {props.right || null}
      </div>
      <div>{props.children}</div>
    </div>
  );
}

export function Empty(props) {
  return (
    <div class="mr-empty">
      <div class="ps2-cube" style={{ width: '38px', height: '38px' }}>
        <div class="ps2-cube__inner">
          <For each={[1, 2, 3, 4, 5, 6]}>
            {() => <i class="ps2-cube__face" />}
          </For>
        </div>
      </div>
      <div class="mr-empty__title">{props.title}</div>
      {props.hint ? <div class="mr-empty__hint" innerHTML={props.hint} /> : null}
      {props.action || null}
    </div>
  );
}

export function Progress(props) {
  return (
    <div class={'ps2-progress' + (props.indeterminate ? ' ps2-progress--indeterminate' : '')}>
      <div class="ps2-progress__fill" style={{ width: (props.percent || 0) + '%' }} />
    </div>
  );
}

/**
 * Copy-the-credit button. Sits next to every download action so the attribution
 * is never more than one click away.
 *
 * When the licence actually requires attribution the button is highlighted and
 * says so. When it does not, it still offers a courtesy credit built from the
 * uploader's own metadata — crediting is never wrong, and having the text to
 * hand is the whole point.
 */
export function CopyAttribution(props) {
  const text = function () {
    const r = props.report;
    if (r && r.attribution && r.attribution.credits) return r.attribution.credits;
    const info = props.info;
    if (!info) return null;
    return License.attribution(info).credits;
  };

  const required = function () {
    return !!(props.report && props.report.requiresAttribution);
  };

  return (
    <Btn
      size={props.size || 'sm'}
      variant={props.variant || (required() ? 'primary' : undefined)}
      label={props.label || (required() ? 'Copy credit ✱' : 'Copy credit')}
      title={required()
        ? 'This licence REQUIRES attribution — copy the exact credit text for your description'
        : 'Copy a ready-made credit line for this material (courtesy credit — not required by the licence)'}
      onClick={(e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        const t = text();
        if (!t) { Toast.warn('Nothing to copy', 'No metadata is loaded for this item yet.'); return; }
        U.copy(t);
        Toast.ok('Credit copied', required()
          ? 'Paste it into your video description — the licence depends on it.'
          : 'Attribution text is on the clipboard.');
      }}
    />
  );
}

/* --- risk rendering ----------------------------------------------------- */

export function LicenseBadge(props) {
  if (props.verifying) return <Badge text="checking…" kind="info" />;
  const b = License.badge(props.report);
  return (
    <span
      class={'ps2-badge ps2-badge--' + b.cls}
      title={props.report ? props.report.levelInfo.line + ' — risk score ' + props.report.score : ''}
    >
      <i class="ps2-badge__dot" />
      <span>{b.text}</span>
    </span>
  );
}

export function Verdict(props) {
  const r = props.report;
  return (
    <div class={'mr-verdict mr-verdict--' + r.levelInfo.tone}>
      <div class="mr-verdict__seal">{r.levelInfo.seal}</div>
      <div class="ps2-grow">
        <div class="mr-verdict__title">{r.levelInfo.title}</div>
        <div class="mr-verdict__line" innerHTML={r.levelInfo.line} />
      </div>
      <div class="mr-verdict__score">
        <b>{r.score}</b>
        <span class="ps2-caption">risk</span>
      </div>
    </div>
  );
}

const SEV_ICON = { pos: '✓', crit: '✕', warn: '!', info: 'i' };

export function Signal(props) {
  const s = props.s;
  return (
    <div class={'mr-signal mr-signal--' + s.severity}>
      <span class="mr-signal__icon">{SEV_ICON[s.severity] || '·'}</span>
      <div class="ps2-grow">
        <div class="mr-signal__label">{s.label}</div>
        {s.detail ? <div class="mr-signal__detail">{s.detail}</div> : null}
        {s.evidence ? <code class="mr-signal__evidence">{s.evidence}</code> : null}
      </div>
    </div>
  );
}

function AuditHead(props) {
  return (
    <div class="mr-section__title">
      <span>{props.title}</span>
      <span class="ps2-caption" style={{ marginLeft: 'auto' }}>{props.right}</span>
    </div>
  );
}

function ConstraintRow(props) {
  const tone = props.v === 'yes' ? 'ok' : (props.v === 'no' ? 'crit' : 'warn');
  return (
    <div class="mr-constraint">
      <span class="mr-constraint__key">{props.label}</span>
      <span class="ps2-grow">{props.value}</span>
      <Badge text={props.v === 'yes' ? 'YES' : (props.v === 'no' ? 'NO' : 'RESTRICTED')} kind={tone} />
    </div>
  );
}

const C_YES = { yes: 'Yes', no: 'No', restricted: 'Restricted' };

/** The full risk-audit report — mirrors the License Auditor output template. */
export function LicenseReport(props) {
  const report = props.report;
  const opts = props.opts || {};
  const order = { crit: 0, warn: 1, pos: 2, info: 3 };
  const signals = report.signals.slice().sort(function (a, b) {
    return (order[a.severity] || 9) - (order[b.severity] || 9);
  });

  return (
    <div>
      <Verdict report={report} />

      {!report.verified && (
        <div class="mr-claimwarn" style={{ marginBottom: '12px' }}>
          <span>⏳</span>
          <span innerHTML={
            'Full metadata has not been fetched, so no licence field exists to check. ' +
            '<b>Nothing here can be trusted until you run the checker.</b>'} />
        </div>
      )}

      <AuditHead title="1 · Technical metadata findings"
        right={report.contentId ? 'Content ID fingerprint' : ''} />
      <div class="mr-audit">
        <div class="mr-constraint">
          <span class="mr-constraint__key">Platform licence field</span>
          <span class="ps2-grow">{report.technical.platformLicense}</span>
        </div>
        <div class="mr-constraint">
          <span class="mr-constraint__key">Content ID fingerprint</span>
          <span class="ps2-grow">
            {report.contentId
              ? 'Yes — ' + report.technical.contentIdSignals.join(', ')
              : 'No automated tracking blocks detected'}
          </span>
          <Badge text={report.contentId ? 'CLAIMED' : 'CLEAR'} kind={report.contentId ? 'crit' : 'ok'} />
        </div>
      </div>

      <AuditHead title="2 · Description &amp; text audit"
        right={report.audit.statedLicense} />
      <div class="mr-audit">
        <div class="mr-constraint">
          <span class="mr-constraint__key">Stated licence</span>
          <span class="ps2-grow">{report.audit.statedLicense}</span>
        </div>
        <div class="mr-constraint">
          <span class="mr-constraint__key">Monetisation traps</span>
          <span class="ps2-grow">
            {report.audit.monetizationTraps.length
              ? report.audit.monetizationTraps.join(' · ')
              : 'None detected'}
          </span>
        </div>
        <div class="mr-constraint">
          <span class="mr-constraint__key">Derivative flags</span>
          <span class="ps2-grow">
            {report.audit.derivativeFlags.length
              ? report.audit.derivativeFlags.join(' · ')
              : 'None detected'}
          </span>
        </div>
        {report.claims.length ? (
          <div class="mr-constraint">
            <span class="mr-constraint__key">Reuse claims</span>
            <span class="ps2-grow">{report.claims.join(' · ')}</span>
          </div>
        ) : null}
      </div>

      <AuditHead title="3 · Operational constraints" />
      <div class="mr-audit">
        <ConstraintRow label="Commercial use" v={report.constraints.commercialUse}
          value={C_YES[report.constraints.commercialUse]} />
        <ConstraintRow label="Modification / editing" v={report.constraints.modification}
          value={C_YES[report.constraints.modification]} />
        <ConstraintRow label="Attribution required" v={report.constraints.attributionRequired ? 'yes' : 'no'}
          value={report.constraints.attributionRequired ? 'Yes — exact text below' : 'No'} />
      </div>

      {report.attribution && (
        <>
          <div class="mr-section__title" style={{ marginTop: '12px' }}>
            <span>Required attribution text</span>
            <button
              class="ps2-btn ps2-btn--sm ps2-btn--ghost"
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                U.copy(report.attribution.credits);
                Toast.ok('Copied', 'Attribution text is on the clipboard.');
              }}
            >
              Copy
            </button>
          </div>
          <div class="mr-attrib">{report.attribution.credits}</div>
        </>
      )}

      <AuditHead title="4 · Final verdict" />
      <div class="mr-claimwarn" style={report.level === 'LOW' ? {
        color: 'var(--ps2-ok)', background: 'rgba(69,214,127,0.07)',
        borderColor: 'rgba(69,214,127,0.3)', borderLeftColor: 'var(--ps2-ok)'
      } : report.level === 'MODERATE' ? {
        color: 'var(--ps2-warn)', background: 'rgba(255,178,61,0.07)',
        borderColor: 'rgba(255,178,61,0.28)', borderLeftColor: 'var(--ps2-warn)'
      } : {
        color: 'var(--ps2-crit)', background: 'rgba(255,59,82,0.08)',
        borderColor: 'rgba(255,59,82,0.32)', borderLeftColor: 'var(--ps2-crit)'
      }}>
        <span>{report.level === 'LOW' ? '✓' : report.level === 'MODERATE' ? '!' : '⛔'}</span>
        <span>{report.verdict.text}</span>
      </div>

      <div class="mr-section__title" style={{ marginTop: '14px' }}>
        <span>Evidence</span>
        <span class="ps2-caption" style={{ marginLeft: 'auto' }}>
          {report.counts.crit + ' critical · ' + report.counts.warn + ' warning'}
        </span>
      </div>
      <div class="mr-signals">
        <For each={signals}>{(s) => <Signal s={s} />}</For>
      </div>

      {report.obligations.length > 0 && (
        <>
          <div class="mr-section__title" style={{ marginTop: '14px' }}>Your obligations</div>
          <div>
            <For each={report.obligations}>
              {(o) => (
                <div class="mr-obligation">
                  <span class="mr-obligation__key">{o.key}</span>
                  <span class="ps2-grow">{o.text}</span>
                </div>
              )}
            </For>
          </div>
        </>
      )}

      {opts.footer}
    </div>
  );
}

/* --- media cards --------------------------------------------------------- */

/**
 * A search result card.
 * @param {object} r       normalised search result
 * @param {object} handlers { onOpen, onVerify, onDownload }
 */
export function ResultCard(props) {
  const r = props.r;
  const handlers = props.handlers || {};
  const report = r.report;

  return (
    <div
      class="mr-card"
      data-tier={report ? report.level : 'UNKNOWN'}
      data-id={r.id}
      onClick={() => handlers.onOpen && handlers.onOpen(r)}
    >
      <div class="mr-card__thumb"
        title="Play the preview"
        onClick={(e) => { e.stopPropagation(); handlers.onPlay ? handlers.onPlay(r) : handlers.onOpen && handlers.onOpen(r); }}>
        <img src={r.thumb} loading="lazy"
          onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        <div class="mr-card__playbtn">▶</div>
        {r.duration ? <span class="mr-card__dur">{U.hhmmss(r.duration)}</span> : null}
      </div>

      <div class="mr-card__body">
        <div class="mr-card__title" title={r.title}>{r.title}</div>
        <div class="mr-card__meta">
          {r.channel ? <span class="ps2-truncate">{r.channel}</span> : null}
          {r.views ? <span>{U.compact(r.views) + ' views'}</span> : null}
          {r.uploadDate ? <span>{U.ago(r.uploadDate)}</span> : null}
        </div>
        <div class="mr-card__tags">
          <LicenseBadge report={report} verifying={r.verifying} />
          {report && report.claims.length ? (
            <Badge text={report.claims.length + ' claim' + (report.claims.length > 1 ? 's' : '')} kind="info" />
          ) : null}
          {report && report.counts.crit ? (
            <Badge text={report.counts.crit + ' critical'} kind="crit" />
          ) : null}
        </div>
        <div class="mr-card__actions">
          {report ? (
            <Btn size="sm" label="Video" title="Video stream only"
              onClick={(e) => { e.stopPropagation(); handlers.onDownload && handlers.onDownload(r, 'video'); }} />
          ) : (
            <Btn size="sm" label="Verify"
              onClick={(e) => { e.stopPropagation(); handlers.onVerify && handlers.onVerify(r); }} />
          )}
          {report ? (
            <Btn size="sm" label="Audio" title="Extracted audio only"
              onClick={(e) => { e.stopPropagation(); handlers.onDownload && handlers.onDownload(r, 'audio'); }} />
          ) : null}
          {report ? <CopyAttribution report={report} /> : null}
        </div>
      </div>

      {r.verifying && (
        <div class="ps2-progress ps2-progress--indeterminate"
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '2px' }}>
          <div class="ps2-progress__fill" />
        </div>
      )}
    </div>
  );
}
