import { useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { useAuth } from '../../utils/authContext';
import { formatDate } from '../../utils/format';
import brand from '../../brand';

/** The QR code, drawn here from the grid of cells the server worked out. No image service, no markup from the wire. */
function QrCode({ qr, size = 208 }) {
  if (!qr || !qr.size || !qr.cells) return null;
  const n = qr.size;
  const quiet = 4; // the white margin scanners need
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.cells[y * n + x] === '1') d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  const total = n + quiet * 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${total} ${total}`} role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges" style={{ display: 'block', background: '#fff', border: '1px solid var(--border-primary)', borderRadius: 8 }}>
      <rect width={total} height={total} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

function RecoveryCodes({ codes, onDone }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  function download() {
    const blob = new Blob([`${brand.name} admin recovery codes\nEach code signs in once, in place of the authenticator code.\n\n${text}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'straightedge-recovery-codes.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="card" style={{ padding: 24, maxWidth: 620 }} data-testid="recovery-codes">
      <h3 className="display" style={{ fontSize: 18, marginBottom: 6 }}>Save these recovery codes now</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        If the phone is lost or wiped, one of these signs you in instead of the app's code. Each works once.
        <b> This is the only time they are shown.</b> Print them or keep them in a password manager, not on the phone that has the app.
      </p>
      <ul className="recovery-codes">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-outline" onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" className="btn btn-outline" onClick={download}>Download as a text file</button>
        <button type="button" className="btn btn-primary" onClick={onDone}>I have saved them</button>
      </div>
    </div>
  );
}

/**
 * Admin → Security: two-step sign-in for the admin account.
 *
 * Off:      enter the password → the server makes a secret and shows the QR code
 *           and setup key once → enter the app's 6-digit code → on.
 * On:       when it was switched on and how many recovery codes are left; make
 *           new recovery codes; switch it off (password + a code).
 */
export default function SecurityTab({ onChanged }) {
  const { login, refresh } = useAuth();
  const [status, setStatus] = useState(null);
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState(null);       // { setupKey, otpauthUri, qr }
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);       // recovery codes, shown once
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState('');         // '' | 'codes' | 'off'
  const [offUseRecovery, setOffUseRecovery] = useState(false);

  async function load() {
    try { setStatus(await api.getTwoFactor()); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); } catch (err) { setError(err.message || 'That did not work. Try again.'); }
    setBusy(false);
  };

  const start = (e) => { e.preventDefault(); run(async () => { setSetup(await api.setupTwoFactor(password)); setPassword(''); setCode(''); }); };
  const enable = (e) => { e.preventDefault(); run(async () => {
    const r = await api.enableTwoFactor(code);
    login(r); // this session carries on under a new token; the others were ended
    setCodes(r.recoveryCodes); setSetup(null); setCode('');
    await load(); onChanged?.();
  }); };
  const regenerate = (e) => { e.preventDefault(); run(async () => { const r = await api.newRecoveryCodes(code); setCodes(r.recoveryCodes); setCode(''); setPanel(''); await load(); }); };
  const switchOff = (e) => { e.preventDefault(); run(async () => {
    const r = await api.disableTwoFactor(offUseRecovery ? { password, recoveryCode: code } : { password, code });
    login(r); setPassword(''); setCode(''); setPanel('');
    await load(); await refresh(); onChanged?.();
  }); };

  if (!status) return <div className="card" style={{ padding: 24 }}>{error ? <span role="alert" style={{ color: 'var(--error-text)' }}>{error}</span> : 'Loading…'}</div>;

  if (codes) return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;

  return (
    <div style={{ display: 'grid', gap: 20, maxWidth: 720 }} data-testid="security-tab">
      <div className="card" style={{ padding: 24 }}>
        <div className="flex-between" style={{ marginBottom: 8, gap: 12, flexWrap: 'wrap' }}>
          <h2 className="display" style={{ fontSize: 20 }}>Two-step sign-in</h2>
          <span className={`tag ${status.enabled ? 'tag-pass' : 'tag-fail'}`} data-testid="twofactor-status">{status.enabled ? 'On' : 'Off'}</span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          The admin account can change prices, see every customer's files and download the database. With two-step sign-in,
          a stolen or guessed password is not enough: signing in also takes a 6-digit code from an authenticator app on your phone
          (Google Authenticator, Microsoft Authenticator, 1Password, Authy).
        </p>

        {status.enabled && (
          <div style={{ marginTop: 14, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            On since {formatDate(status.enabledAt)}. Recovery codes left: <b data-testid="codes-left">{status.recoveryCodesLeft}</b> of 10.
            {status.recoveryCodesLeft <= 3 && <span style={{ color: 'var(--warn-text)' }}> Make new ones before they run out.</span>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-outline" onClick={() => { setPanel(panel === 'codes' ? '' : 'codes'); setError(''); setCode(''); }}>Make new recovery codes</button>
              <button type="button" className="btn btn-ghost" onClick={() => { setPanel(panel === 'off' ? '' : 'off'); setError(''); setCode(''); setPassword(''); }}>Switch two-step sign-in off</button>
            </div>
          </div>
        )}

        {/* ─── Off: step 1, confirm it is you ─── */}
        {!status.enabled && !setup && (
          <form onSubmit={start} style={{ marginTop: 16 }}>
            <label className="field-label" htmlFor="tf-password">Your password, to start</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input id="tf-password" type="password" className="input" style={{ maxWidth: 280 }} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Starting…' : 'Set up two-step sign-in'}</button>
            </div>
            <span className="field-hint">Takes about two minutes. Have your phone to hand.</span>
          </form>
        )}

        {/* ─── Off: step 2, scan and confirm ─── */}
        {!status.enabled && setup && (
          <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 24, alignItems: 'start' }} data-testid="twofactor-setup">
            <QrCode qr={setup.qr} />
            <div>
              <ol style={{ margin: '0 0 12px 18px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                <li>Open the authenticator app and choose "add an account" or the + button.</li>
                <li>Scan this code. No camera? Type the setup key below instead.</li>
                <li>Enter the 6-digit code the app now shows for {brand.name}.</li>
              </ol>
              <div className="field-label">Setup key</div>
              <div className="setup-key" data-testid="setup-key">{setup.setupKey}</div>
              <span className="field-hint">Shown once. If you leave this page before finishing, start again and scan the new code.</span>
              <form onSubmit={enable} style={{ marginTop: 14 }}>
                <label className="field-label" htmlFor="tf-code">6-digit code from the app</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input id="tf-code" className="input" style={{ maxWidth: 160, fontFamily: 'var(--font-mono)', letterSpacing: 2 }} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required />
                  <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Checking…' : 'Switch it on'}</button>
                  <button type="button" className="btn btn-ghost" onClick={() => { setSetup(null); setCode(''); setError(''); }}>Cancel</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {panel === 'codes' && (
          <form onSubmit={regenerate} style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
            <label className="field-label" htmlFor="tf-regen">Current 6-digit code from the app</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input id="tf-regen" className="input" style={{ maxWidth: 160 }} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
              <button type="submit" className="btn btn-primary" disabled={busy}>Make ten new codes</button>
            </div>
            <span className="field-hint">The old codes stop working the moment the new ones are made.</span>
          </form>
        )}

        {panel === 'off' && (
          <form onSubmit={switchOff} style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-subtle)', display: 'grid', gap: 12, maxWidth: 360 }}>
            <div>
              <label className="field-label" htmlFor="tf-off-password">Your password</label>
              <input id="tf-off-password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </div>
            <div>
              <label className="field-label" htmlFor="tf-off-code">{offUseRecovery ? 'A recovery code' : 'Current 6-digit code from the app'}</label>
              <input id="tf-off-code" className="input" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required />
              <span className="field-hint">
                <button type="button" className="linklike-inline" onClick={() => { setOffUseRecovery((v) => !v); setCode(''); }}>{offUseRecovery ? 'Use the app\'s code instead' : 'Use a recovery code instead'}</button>
              </span>
            </div>
            <button type="submit" className="btn btn-danger" disabled={busy}>Switch it off</button>
            <span className="field-hint">After this, the admin account is protected by the password alone.</span>
          </form>
        )}

        {error && <div role="alert" className="auth-error" style={{ marginTop: 14, marginBottom: 0 }}>{error}</div>}
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 8 }}>If you are locked out</h2>
        <ul style={{ margin: '0 0 0 18px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <li>Phone lost, recovery codes to hand: sign in with a recovery code, then switch two-step sign-in off and set it up again on the new phone.</li>
          <li>Phone and codes both lost: set the hosting variable <code>ADMIN_RECOVERY=reset-2fa</code>, restart the service, sign in with your password, set this up again, then remove the variable.</li>
          <li>Password forgotten: use "Forgot your password?" on the sign-in page. Two-step sign-in stays on.</li>
          <li>Admin sessions last 4 hours, then ask you to sign in again.</li>
        </ul>
      </div>
    </div>
  );
}
