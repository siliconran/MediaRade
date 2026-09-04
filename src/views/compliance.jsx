/* =============================================================================
   views/compliance.jsx — the audit trail: policy state, ledger, credits export
   MediaRade by siliconran
   ========================================================================== */
import { For, Show, createSignal, onCleanup } from 'solid-js';
import Bus, { state } from '../core/bus.js';
import Config from '../core/config.js';
import Paths from '../core/paths.js';
import U from '../core/util.js';
import Ledger from '../core/ledger.js';
import License from '../core/license.js';
import { CEP } from '../core/cep.js';
import Toast from '../ui/toast.js';
import { Badge, Btn, Empty, Section } from '../ui/components.jsx';

const EVENT_LABEL = {
  download_start: 'queued',
  download_complete: 'downloaded',
  download_blocked: 'BLOCKED',
  download_error: 'failed',
  download_canceled: 'cancelled',
  timeline_insert: 'placed on timeline',
  file_deleted: 'deleted',
  strict_mode_enabled: 'STRICT MODE ON',
  strict_mode_disabled: 'STRICT MODE OFF'
};

export function ComplianceView() {
  const [rows, setRows] = createSignal(Ledger.read(300));

  const refresh = U.debounce(function () { setRows(Ledger.read(300)); }, 400);
  const off = Bus.on('ledger', refresh);
  onCleanup(off);

  const stats = Ledger.stats();
  const strict = Config.get('strictMode');

  return (
    <div>
      <div class="mr-view__toolbar">
        <div class="ps2-row-gap ps2-wrap">
          <Badge text={strict ? 'STRICT MODE ON' : 'STRICT MODE OFF'} kind={strict ? 'ok' : 'crit'} />
          <Badge text={stats.total + ' downloads'} kind="mute" />
          <Badge text={stats.verified + ' LOW risk'} kind={stats.verified ? 'ok' : 'mute'} />
          {stats.overridden ? <Badge text={stats.overridden + ' overridden'} kind="crit" /> : null}
          {stats.blocked ? <Badge text={stats.blocked + ' blocked'} kind="warn" /> : null}
          <span class="ps2-grow" />
          <Btn size="sm" variant="primary" label="Export report" onClick={() => {
            try {
              const p = Ledger.exportReport();
              Toast.ok('Report written', p);
              CEP.revealInExplorer(p);
            } catch (e) { Toast.err('Export failed', e.message); }
          }} />
          <Btn size="sm" label="Open folder" onClick={() => CEP.openFolder(Paths.dir('compliance'))} />
        </div>
      </div>

      <div class="mr-view__body">
        <div class="ps2-panel" style={{ marginBottom: '14px' }}>
          <div class="ps2-panel__header">
            <span class="ps2-panel__title">How MediaRade decides</span>
          </div>
          <div style={{ fontSize: '11px', lineHeight: '1.7', color: 'var(--ps2-text-secondary)' }} innerHTML={
            '<p style="margin:0 0 8px"><b style="color:var(--ps2-ash)">Only one signal counts.</b> YouTube publishes a ' +
            'machine-readable licence field per upload. It reads either <i>Creative Commons Attribution ' +
            '(reuse allowed)</i> or <i>Standard YouTube Licence</i>. That field is the only thing MediaRade ' +
            'treats as a licence.</p>' +
            '<p style="margin:0 0 8px"><b style="color:var(--ps2-ash)">Text is never a licence.</b> "Royalty free", ' +
            '"no copyright", "free to use" are recorded as <i>claims</i>. When a claim appears on an upload whose ' +
            'licence field says Standard YouTube Licence, that is a <span style="color:var(--ps2-crit)">CRITICAL</span> ' +
            'contradiction — the single most common way people end up with a strike over "free" media.</p>' +
            '<p style="margin:0 0 8px"><b style="color:var(--ps2-ash)">Every upload is rated.</b> A score of 0–100 maps ' +
            'to <b>LOW</b> (verified Creative Commons, no claims), <b>MODERATE</b> (CC with restrictions or unattributed ' +
            'third-party content), <b>HIGH</b> (licence/reuse claims with unresolved conflicts) and ' +
            '<b style="color:var(--ps2-crit)">CRITICAL</b> (Content ID enforcement or a stated licence that YouTube ' +
            'reports as Standard).</p>' +
            '<p style="margin:0 0 8px"><b style="color:var(--ps2-ash)">A CC mark only covers what the uploader owns.</b> ' +
            'Credited music, stock footage and subscription libraries (Epidemic Sound, Artlist, NCS…) keep their own ' +
            'licences. MediaRade flags those separately even on a clean CC upload.</p>' +
            '<p style="margin:0"><b style="color:var(--ps2-ash)">Everything is written down.</b> Each download stores a ' +
            '<code>.license.json</code> and, for CC material, an <code>attribution.txt</code>. HIGH downloads require a ' +
            'written reason; CRITICAL always blocks. Overrides land in an append-only ledger. This is evidence of due ' +
            'diligence — it is not legal advice, and it cannot give you rights you do not hold.</p>'} />
        </div>

        <Show
          when={rows().length > 0}
          fallback={
            <Empty title="Ledger is empty"
              hint={'Every download, block and override will be recorded in ' +
                '<code>Documents\\MediaRade\\Compliance\\license-ledger.jsonl</code>.'} />
          }
        >
          <Section
            title="Ledger — newest first"
            right={<span class="ps2-caption">{rows().length + ' entries'}</span>}
          >
            <div class="ps2-list">
              <For each={rows()}>
                {(r) => {
                  const tone = r.event === 'download_blocked' ? 'warn'
                    : r.event === 'strict_mode_disabled' ? 'crit'
                    : r.override ? 'crit'
                    : r.verdict === 'CRITICAL' ? 'crit'
                    : r.verdict === 'HIGH' ? 'crit'
                    : r.verdict === 'MODERATE' ? 'warn'
                    : r.verdict === 'LOW' ? 'ok'
                    : 'mute';
                  const badge = r.verdict ? License.badgeFromVerdict(r.verdict) : null;
                  return (
                    <div class="ps2-row" style={{ cursor: 'default' }}>
                      <div class="ps2-row__main">
                        <div class="ps2-row__title">{r.title || EVENT_LABEL[r.event] || r.event}</div>
                        <div class="ps2-row__sub">
                          {new Date(r.at).toLocaleString() + '  ·  ' + (EVENT_LABEL[r.event] || r.event) +
                            (r.overrideReason ? '  ·  reason: ' + U.truncate(r.overrideReason, 60) : '')}
                        </div>
                      </div>
                      {r.override ? <Badge text="override" kind="crit" /> : null}
                      {badge
                        ? <Badge text={badge.text} kind={tone} />
                        : <Badge text={EVENT_LABEL[r.event] || r.event} kind={tone} />}
                    </div>
                  );
                }}
              </For>
            </div>
          </Section>
        </Show>
      </div>
    </div>
  );
}

export default ComplianceView;
