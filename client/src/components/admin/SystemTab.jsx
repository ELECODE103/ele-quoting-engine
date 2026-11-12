import { useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { formatFileSize, formatDateTime } from '../../utils/format';

/**
 * Admin → System: is the site healthy, and is anything switched off?
 * Everything shown comes from GET /api/admin/system/status (server/ops/status.js).
 * No secret or address is ever in that answer: a setting is "on" or "off".
 */
const cell = { padding: '9px 14px', borderBottom: '1px solid var(--border-subtle)', fontSize: 12.5, verticalAlign: 'top' };
const label = { ...cell, color: 'var(--text-dim)', width: '42%' };

function Section({ title, children, note }) {
  return (
    <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-primary)', background: 'var(--bg-secondary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)' }}>{title}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>{children}</tbody></table>
      {note && <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}
const Row = ({ k, children }) => (<tr><td style={label}>{k}</td><td style={cell}>{children}</td></tr>);
const Tag = ({ ok, children }) => <span className={`tag ${ok ? 'tag-pass' : 'tag-fail'}`}>{children}</span>;

function uptime(seconds) {
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}
const size = (s) => `${formatFileSize(s.usedBytes)} of ${formatFileSize(s.maxBytes)} (${s.percent}%)`;

export default function SystemTab() {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null); // { title, lines: [{ level, text }] }

  async function load() {
    try { setS(await api.getSystemStatus()); setError(''); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  async function act(name, fn) {
    setBusy(name); setResult(null);
    try { setResult(await fn()); } catch (err) { setResult({ title: 'That did not work', lines: [{ level: 'fail', text: err.message }] }); }
    setBusy('');
    load();
  }
  const sendTest = () => act('mail', async () => {
    const r = await api.sendSystemEmailTest();
    return { title: r.ok && r.sent ? 'Email is working: a test message is on its way to the shop inbox' : r.configured ? 'Email is not working yet' : 'Email is switched off', lines: r.lines };
  });
  const sendDigest = () => act('digest', async () => {
    const r = await api.sendSystemDigest();
    return { title: r.sent ? 'Digest sent to the shop inbox' : 'Digest not sent', lines: r.sent ? [] : [{ level: 'fail', text: r.reason === 'mailer-not-configured' ? 'Email is not configured (EMAIL_API_KEY / EMAIL_FROM).' : 'The email provider refused it. Use "Send a test email" to see why.' }] };
  });

  if (error) return <div className="card" style={{ padding: 24, color: 'var(--error)' }}>Could not load the system status: {error}</div>;
  if (!s) return <div className="card" style={{ padding: 24, color: 'var(--text-dim)' }}>Loading…</div>;

  const off = s.protections.filter((p) => !p.on);
  const t = s.events.totals;
  const p = s.parsing || {};
  const prev = s.previousRun;

  return (
    <div data-testid="system-tab" style={{ maxWidth: 980 }}>
      {off.some((x) => x.critical) && (
        <div className="admin-banner" role="alert">
          <span><b>{off.filter((x) => x.critical).length} protection{off.filter((x) => x.critical).length === 1 ? ' is' : 's are'} switched off.</b> See “Protections” below for what to set in Railway.</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        <button type="button" className="btn btn-outline" onClick={load}>Refresh</button>
        <button type="button" className="btn btn-outline" disabled={busy === 'mail'} onClick={sendTest}>{busy === 'mail' ? 'Checking…' : 'Send a test email'}</button>
        <button type="button" className="btn btn-outline" disabled={busy === 'digest'} onClick={sendDigest}>{busy === 'digest' ? 'Sending…' : 'Send the digest now'}</button>
        <a className="btn btn-outline" href="/api/admin/backup/full">Download full backup</a>
      </div>

      {result && (
        <div className="card" style={{ padding: 16, marginBottom: 20 }} role="status">
          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: result.lines.length ? 8 : 0 }}>{result.title}</div>
          {result.lines.map((l, i) => (
            <div key={i} style={{ fontSize: 12.5, lineHeight: 1.6, color: l.level === 'fail' ? 'var(--error)' : 'var(--text-secondary)' }}>
              <span style={{ display: 'inline-block', width: 44, textTransform: 'uppercase', fontSize: 10.5, fontFamily: 'var(--font-mono)' }}>{l.level}</span>{l.text}
            </div>
          ))}
        </div>
      )}

      <Section title="This deployment">
        <Row k="Build (git commit)"><span style={{ fontFamily: 'var(--font-mono)' }}>{s.build.commit}</span>{s.build.branch ? ` · ${s.build.branch}` : ''}</Row>
        <Row k="Running for">{uptime(s.uptimeSeconds)} · started {formatDateTime(s.startedAt)}</Row>
        <Row k="Node">{s.build.node} · {s.build.environment}</Row>
        <Row k="Previous run ended">{prev ? (prev.ended === 'clean' ? 'cleanly' : prev.ended === 'crash' ? <Tag ok={false}>with a crash{prev.errorName ? ` (${prev.errorName})` : ''}</Tag> : 'without a clean stop (killed or out of memory)') : 'no record'}</Row>
        <Row k="Canonical host">{s.hosts.canonical || <Tag ok={false}>not set</Tag>}{s.hosts.redirects.length ? ` · redirecting from ${s.hosts.redirects.join(', ')}` : ''}</Row>
        <Row k="Requests have arrived for">{(s.hosts.seen || []).map((x) => `${x.host} (${x.requests})`).join(' · ') || 'nothing yet'}</Row>
        {s.hosts.problems.map((x, i) => <Row key={i} k="Host setting"><span style={{ color: 'var(--error)' }}>{x}</span></Row>)}
      </Section>

      <Section title="Protections">
        {s.protections.map((x) => (
          <Row key={x.key} k={x.label}><Tag ok={x.on}>{x.on ? 'on' : 'off'}</Tag>{!x.on && <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>{x.fix}</div>}</Row>
        ))}
      </Section>

      <Section title="Storage">
        {s.storage.unavailable && <Row k="Sizes"><Tag ok={false}>not available</Tag></Row>}
        <Row k="Customer files">{size(s.storage.files)}</Row>
        <Row k="Database">{size(s.storage.database)}</Row>
        {s.storage.volume && <Row k="Railway volume">{s.storage.volume.percentUsed}% used · {formatFileSize(s.storage.volume.freeBytes)} free</Row>}
        <Row k="Last full backup downloaded">{s.backups.lastFullDownloadAt ? formatDateTime(s.backups.lastFullDownloadAt) : 'never from this page'}</Row>
      </Section>

      <Section title="Waiting on you">
        <Row k="Requests waiting for a quote">{s.business.requests.open}{s.business.requests.open ? ` · oldest ${Math.round(s.business.requests.oldestHours)} h` : ''}</Row>
        <Row k={`Firm quotes lapsing within ${s.business.quotes.expirySoonDays} days`}>{s.business.quotes.firmExpiring.length}</Row>
        <Row k="Orders needing a look">{s.business.orders.needingAttention.length ? s.business.orders.needingAttention.map((o) => `${o.reference} (${o.status})`).join(', ') : 'none'}</Row>
        <Row k="Orders by status">{s.business.orders.statuses.map((x) => `${x.status}: ${x.count}`).join(' · ') || 'none yet'}</Row>
      </Section>

      <Section title={`Since the last restart (${formatDateTime(s.events.countingSince)})`} note="These counters are kept in memory and start again whenever the site restarts or is redeployed. Alert and digest timing is kept on the volume and survives a restart; orders, requests and sizes are read fresh each time.">
        <Row k="Emails sent / failed / not sent (email off)">{t.mailSent || 0} / {t.mailFailed || 0} / {t.mailNotConfigured || 0}</Row>
        <Row k="Stripe webhooks ok / bad signature / other failure">{t.webhookOk || 0} / {t.webhookRejected || 0} / {(t.webhookFailed || 0) + (t.webhookRefused || 0)}</Row>
        <Row k="Server errors (5xx)">{t.serverError || 0}</Row>
        <Row k="Sign-in: accounts paused / attempts refused while paused">{t.signinPauseStarted || 0} / {t.signinPaused || 0}</Row>
        <Row k="Uploads refused: storage full">{t.storageRefused || 0}</Row>
        <Row k="File parsing: timed out / told “busy” / out of memory">{p.timedOut || 0} / {p.busy || 0} / {p.outOfMemory || 0}</Row>
      </Section>

      {s.extras && Object.keys(s.extras).length > 0 && (
        <Section title="Limits and budgets">
          {Object.entries(s.extras).map(([k, v]) => (
            <Row key={k} k={k}>{v && typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${a}: ${typeof b === 'object' ? JSON.stringify(b) : b}`).join(' · ') : String(v)}</Row>
          ))}
        </Section>
      )}

      <Section title="Alerts and digest">
        {s.digest && <Row k="Daily digest">{s.digest.schedule === 'on' ? `${s.digest.hourCentral}:00 Central` : 'switched off'} · last sent {s.digest.lastSentAt ? formatDateTime(s.digest.lastSentAt) : 'never'}{!s.digest.mailerConfigured && ' · email is off, so it is not being sent'}</Row>}
        {s.alerts.length === 0 && <Row k="Alerts raised since the restart">none</Row>}
        {s.alerts.map((a) => <Row key={a.key} k={a.title}>last {formatDateTime(a.lastAt)} · {a.lastEmailedAt ? `emailed ${formatDateTime(a.lastEmailedAt)}` : 'in the deploy log only'}</Row>)}
      </Section>
    </div>
  );
}
