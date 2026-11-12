import { useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { useAuth } from '../../utils/authContext';
import { formatDate } from '../../utils/format';
import brand from '../../brand';
import CodeField from '../form/CodeField';
import PasswordField from '../form/PasswordField';
import { FormError } from '../form/Notice';

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
    <svg width={size} height={size} viewBox={`0 0 ${total} ${total}`} role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges" style={{ display: 'block', maxWidth: '100%', height: 'auto', background: '#fff', border: '1px solid var(--border-primary)', borderRadius: 8 }}>
      <rect width={total} height={total} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/**
 * The ten recovery codes, shown once. Says in plain words what they are for,
 * and gives three ways to keep them (copy, a text file, paper) before the one
 * button that leaves the screen.
 */
function RecoveryCodes({ codes, onDone }) {
  const [saved, setSaved] = useState(''); // what the owner has done with them, said back in words
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const text = codes.join('\n');
  const sheet = `${brand.name} admin recovery codes\nMade ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}\n\nEach code signs in once, in place of the 6-digit code from the authenticator app.\nCross a code off when you use it.\n\n${text}\n`;
  async function copy() {
    try { await navigator.clipboard.writeText(text); setSaved('Copied. Paste them into your password manager now, before you copy anything else.'); }
    catch { setSaved('This browser would not let us copy. Select the codes above and copy them by hand, or use the download or print button.'); }
  }
  function download() {
    const blob = new Blob([sheet], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'straightedge-recovery-codes.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaved('Downloaded as straightedge-recovery-codes.txt. Move the file somewhere that is not this computer\'s desktop or the phone with the app.');
  }
  function print() {
    window.print();
    setSaved('Sent to the printer. Keep the sheet where you keep the shop\'s other keys.');
  }
  return (
    <div className="card print-area" style={{ padding: 24, maxWidth: 620 }} data-testid="recovery-codes">
      <div className="field-label">Step 3 of 3</div>
      <h2 className="display" style={{ fontSize: 20, marginBottom: 8 }} tabIndex={-1} ref={heading}>Save your recovery codes</h2>
      <p className="admin-copy">
        Two-step sign-in is on. These ten codes are the spare keys: if the phone is lost, broken or replaced, one of them signs you in
        in place of the app's code. Each works once.
      </p>
      <p className="admin-copy">
        <b>This is the only time they are shown.</b> Keep them in a password manager or on paper, not on the phone that has the app.
        Without the phone and without these, the only way back in is a setting on the hosting account.
      </p>
      <ul className="recovery-codes" aria-label="Recovery codes">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      <div className="notice-actions no-print">
        <button type="button" className="btn btn-outline" onClick={copy}>Copy</button>
        <button type="button" className="btn btn-outline" onClick={download}>Download as a text file</button>
        <button type="button" className="btn btn-outline" onClick={print}>Print</button>
      </div>
      <p role="status" aria-live="polite" className="field-hint no-print" style={{ minHeight: 18, margin: '8px 0 14px' }}>{saved}</p>
      <button type="button" className="btn btn-primary btn-lg no-print" onClick={onDone}>I have saved them</button>
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
export default function SecurityTab({ onChanged, enrolment = false, onCodesSaved }) {
  const { login, refresh } = useAuth();
  const [status, setStatus] = useState(null);
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState(null);       // { setupKey, otpauthUri, qr }
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);       // recovery codes, shown once
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorAt, setErrorAt] = useState(0);
  const [keyCopied, setKeyCopied] = useState(false);
  const [panel, setPanel] = useState('');         // '' | 'codes' | 'off'
  const [offUseRecovery, setOffUseRecovery] = useState(false);

  async function load() {
    try { setStatus(await api.getTwoFactor()); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); } catch (err) { setError(err.message || 'That did not work. Try again.'); setErrorAt((n) => n + 1); }
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

  if (!status) return <div className="card" style={{ padding: 24 }}>{error ? <span role="alert" style={{ color: 'var(--error-text)' }}>{error}</span> : <span role="status">Loading…</span>}</div>;

  if (codes) return <RecoveryCodes codes={codes} onDone={() => { setCodes(null); onCodesSaved?.(); }} />;

  return (
    <div style={{ display: 'grid', gap: 20, maxWidth: 720 }} data-testid="security-tab">
      <div className="card" style={{ padding: 24 }}>
        <div className="flex-between" style={{ marginBottom: 8, gap: 12, flexWrap: 'wrap' }}>
          <h2 className="display" style={{ fontSize: 20 }}>Two-step sign-in</h2>
          <span className={`tag ${status.enabled ? 'tag-pass' : 'tag-fail'}`} data-testid="twofactor-status">{status.enabled ? 'On' : 'Off'}</span>
        </div>
        <p className="admin-copy">
          The admin account can change prices, see every customer's files and download the database. With two-step sign-in,
          a stolen or guessed password is not enough: signing in also takes a 6-digit code from an authenticator app on your phone
          (Google Authenticator, Microsoft Authenticator, 1Password, Authy).
        </p>

        {status.enabled && enrolment && (
          <div style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-primary" onClick={() => onCodesSaved?.()}>Open the admin pages</button>
          </div>
        )}
        {status.enabled && !enrolment && (
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
          <form onSubmit={start} style={{ marginTop: 16 }} aria-busy={busy || undefined}>
            <div className="field-label">Step 1 of 3</div>
            <p className="admin-copy" style={{ marginBottom: 12 }}>
              You need your phone and an authenticator app on it. Start by entering your password, so we know it is you switching this on.
            </p>
            <PasswordField id="tf-password" label="Your password, to start" value={password} onChange={setPassword} autoComplete="current-password" style={{ maxWidth: 320 }} />
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Starting…' : 'Set up two-step sign-in'}</button>
            <span className="field-hint" style={{ marginTop: 8 }}>Takes about two minutes.</span>
          </form>
        )}

        {/* ─── Off: step 2, scan and confirm ─── */}
        {!status.enabled && setup && (
          <div style={{ marginTop: 18 }} data-testid="twofactor-setup">
            <div className="field-label">Step 2 of 3</div>
            <div className="tf-setup">
              <QrCode qr={setup.qr} />
              <div style={{ minWidth: 0 }}>
                <ol className="tf-steps">
                  <li>Open the authenticator app and choose "add an account" or the + button.</li>
                  <li>Scan this code. On the phone you are reading this on, or with no camera? Type the setup key below into the app instead.</li>
                  <li>Enter the 6-digit code the app now shows for {brand.name}.</li>
                </ol>
                <div className="field-label">Setup key</div>
                <div className="setup-key" data-testid="setup-key">{(setup.setupKey || '').replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim()}</div>
                <div className="notice-actions" style={{ marginTop: 6 }}>
                  <button type="button" className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(setup.setupKey).then(() => setKeyCopied(true), () => setKeyCopied(false))}>{keyCopied ? 'Copied' : 'Copy the key'}</button>
                  <span className="field-hint" style={{ margin: 0 }} role="status">{keyCopied ? 'Paste it into the app as the secret key.' : 'Shown once. The spaces are only there to make it easier to read.'}</span>
                </div>
                <form onSubmit={enable} style={{ marginTop: 16 }} aria-busy={busy || undefined}>
                  <CodeField id="tf-code" label="6-digit code from the app" value={code} onChange={setCode} autoFocus inputStyle={{ maxWidth: 180 }}
                    help="The code changes every 30 seconds. Enter the one showing now." />
                  <div className="notice-actions">
                    <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Checking…' : 'Switch it on'}</button>
                    <button type="button" className="btn btn-ghost" onClick={() => { setSetup(null); setCode(''); setError(''); }}>Cancel</button>
                  </div>
                  <span className="field-hint" style={{ marginTop: 8 }}>If you leave this page before finishing, start again and scan the new code: this one stops working.</span>
                </form>
              </div>
            </div>
          </div>
        )}

        {panel === 'codes' && (
          <form onSubmit={regenerate} style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
            <CodeField id="tf-regen" label="Current 6-digit code from the app" value={code} onChange={setCode} autoFocus inputStyle={{ maxWidth: 180 }}
              help="The old codes stop working the moment the new ones are made." />
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Making them…' : 'Make ten new codes'}</button>
          </form>
        )}

        {panel === 'off' && (
          <form onSubmit={switchOff} style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-subtle)', display: 'grid', gap: 12, maxWidth: 360 }}>
            <PasswordField id="tf-off-password" label="Your password" value={password} onChange={setPassword} autoComplete="current-password" style={{ marginBottom: 0 }} />
            <CodeField
              id="tf-off-code"
              key={offUseRecovery ? 'recovery' : 'totp'}
              label={offUseRecovery ? 'A recovery code' : 'Current 6-digit code from the app'}
              value={code}
              onChange={setCode}
              recovery={offUseRecovery}
              style={{ marginBottom: 0 }}
              help={<button type="button" className="linklike-inline" onClick={() => { setOffUseRecovery((v) => !v); setCode(''); }}>{offUseRecovery ? 'Use the app\'s code instead' : 'Use a recovery code instead'}</button>}
            />
            <button type="submit" className="btn btn-danger" disabled={busy}>{busy ? 'Switching it off…' : 'Switch it off'}</button>
            <span className="field-hint">Two-step sign-in is required for the admin pages: after switching it off you are taken straight back to setting it up (on a new phone, say), and nothing else opens until you have.</span>
          </form>
        )}

        <FormError error={error} at={errorAt} style={{ marginTop: 14, marginBottom: 0 }} />
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 8 }}>If you are locked out</h2>
        <ul style={{ margin: '0 0 0 18px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          <li>Phone lost, recovery codes to hand: sign in with a recovery code, then switch two-step sign-in off and set it up again on the new phone.</li>
          <li>Phone and codes both lost: set the hosting variable <code>ADMIN_RECOVERY=reset-2fa</code>, restart the service, sign in with your password, set this up again (the admin pages stay closed until you do), then remove the variable.</li>
          <li>Password forgotten: use "Forgot your password?" on the sign-in page. Two-step sign-in stays on.</li>
          <li>Admin sessions last 4 hours, then ask you to sign in again.</li>
        </ul>
      </div>
    </div>
  );
}
