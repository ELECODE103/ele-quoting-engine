import { useState } from 'react';

/**
 * The rules a new password has to meet, as the server applies them
 * (server/security/passwords.js). Checked here as the buyer types so nobody
 * finds out about a rule by having the form refused. The server stays the
 * judge: it also refuses the most-used passwords, which this page cannot know.
 */
export const PASSWORD_RULES = [
  { id: 'length', label: 'At least 10 characters', test: (p) => p.length >= 10 },
  { id: 'upper', label: 'An upper-case letter', test: (p) => /[A-Z]/.test(p) },
  { id: 'lower', label: 'A lower-case letter', test: (p) => /[a-z]/.test(p) },
  { id: 'number', label: 'A number', test: (p) => /[0-9]/.test(p) },
];
export const PASSWORD_HINT = 'At least 10 characters, with an upper-case letter, a lower-case letter and a number. Not a common password.';

/** What is still missing, as a sentence, or '' when the four rules are met. */
export function passwordProblem(password, { email = '' } = {}) {
  const missing = PASSWORD_RULES.filter((r) => !r.test(password)).map((r) => r.label.charAt(0).toLowerCase() + r.label.slice(1));
  if (missing.length) return `The password still needs: ${missing.join(', ')}.`;
  if (new TextEncoder().encode(password).length > 72) return 'That password is longer than we can store. Use 72 characters or fewer.';
  const local = String(email).toLowerCase().split('@')[0];
  if (local.length >= 4 && password.toLowerCase().includes(local)) return 'Choose a password that does not contain your email address: it is the first thing someone would try.';
  return '';
}

/**
 * A password box with a labelled show/hide control and, for a new password,
 * the rules listed underneath with a tick against each one that is met.
 *
 *   autoComplete   "current-password" to sign in, "new-password" to set one:
 *                  this is what lets a phone or a password manager fill it or
 *                  offer to make one
 *   rules          show the rules (new passwords only)
 *   hint           one line under the field instead of the rules
 */
export default function PasswordField({ id, label, value, onChange, autoComplete, rules = false, hint, invalid = false, describedBy = '', autoFocus = false, required = true, style }) {
  const [shown, setShown] = useState(false);
  const help = rules ? `${id}-rules` : hint ? `${id}-hint` : '';
  const describe = [help, describedBy].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field" style={style}>
      <div className="field-top">
        <label className="field-label" htmlFor={id}>{label}</label>
        <button type="button" className="field-toggle" aria-pressed={shown} aria-controls={id} onClick={() => setShown((v) => !v)}>
          {shown ? 'Hide password' : 'Show password'}
        </button>
      </div>
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        minLength={rules ? 10 : undefined}
        maxLength={rules ? 72 : 200}
        required={required}
        aria-invalid={invalid || undefined}
        aria-describedby={describe}
        autoFocus={autoFocus}
      />
      {rules && (
        <div id={help} className="pw-rules">
          <ul>
            {PASSWORD_RULES.map((r) => {
              const met = r.test(value);
              return (
                <li key={r.id} className={met ? 'met' : ''}>
                  <span aria-hidden="true" className="pw-mark">{met ? '✓' : '·'}</span>
                  {r.label}
                  <span className="sr-only">{met ? ' (done)' : value ? ' (still needed)' : ''}</span>
                </li>
              );
            })}
          </ul>
          <p>Not one of the passwords everybody uses, and not built from your email address or our name.</p>
        </div>
      )}
      {!rules && hint && <span id={help} className="field-hint">{hint}</span>}
    </div>
  );
}
