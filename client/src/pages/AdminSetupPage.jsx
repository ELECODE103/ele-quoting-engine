import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../utils/authContext';
import { api } from '../utils/api';
import Wordmark from '../components/Wordmark';
import brand from '../brand';

/**
 * One-time setup of the admin account. Not linked from anywhere: the owner
 * opens /admin/setup after setting a setup code in the host's variables. It
 * takes that code and a new password, and goes straight on to the admin pages,
 * which ask for two-step sign-in to be switched on before anything else opens.
 */
export default function AdminSetupPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { document.title = `Admin setup · ${brand.name}`; }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== again) return setError('The two passwords are not the same. Type the new password again.');
    setLoading(true);
    try {
      const result = await api.adminSetup(code, password);
      login(result);
      navigate('/admin', { replace: true });
    } catch (err) {
      setError(err.message || `That didn't work. Check the setup code and try again, or call ${brand.phone}.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 440 }}>
        <div className="auth-head">
          <div style={{ marginBottom: 24 }}><Wordmark size={18} /></div>
          <h1 className="display" style={{ fontSize: 28, marginBottom: 8 }}>Admin setup</h1>
          <p>
            This sets up the admin account once. Enter the setup code you put in the site's settings, then choose
            the password you will sign in with. Next you will be asked to set up two-step sign-in.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label className="field-label" htmlFor="setup-code">Setup code</label>
            <input
              id="setup-code"
              type="password"
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              required
              aria-describedby="setup-code-help"
            />
            <span id="setup-code-help" className="field-hint">The code you set yourself. It works once.</span>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label className="field-label" htmlFor="setup-password">New password</label>
            <input
              id="setup-password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              aria-describedby="setup-password-help"
            />
            <span id="setup-password-help" className="field-hint">At least 10 characters, with an upper-case letter, a lower-case letter and a number. Not a common password.</span>
          </div>

          <div style={{ marginBottom: 20 }}>
            <label className="field-label" htmlFor="setup-password-again">New password again</label>
            <input
              id="setup-password-again"
              type="password"
              className="input"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>

          {error && <div role="alert" className="auth-error">{error}</div>}

          <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center', marginBottom: 16 }} disabled={loading}>
            {loading ? 'Setting up…' : 'Set up the admin account'}
          </button>
        </form>

        <div className="auth-foot" style={{ marginTop: 0 }}>
          Already set up? <Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
