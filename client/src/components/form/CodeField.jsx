/**
 * A one-time code box: the 6-digit code from an authenticator app, or one of
 * the saved recovery codes in its place.
 *
 * For the 6-digit code a phone shows its number pad (inputMode) and offers the
 * code it has just received or generated (autoComplete "one-time-code").
 * Spaces are accepted and dropped by the server ("123 456" is how most apps
 * print it). A recovery code is letters and numbers, so it gets the ordinary
 * keyboard with capitals on and correction off.
 */
export default function CodeField({ id, label, value, onChange, recovery = false, help, invalid = false, autoFocus = false, style, inputStyle }) {
  return (
    <div className="field" style={style}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        className="input code-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={recovery ? 'text' : 'numeric'}
        autoComplete={recovery ? 'off' : 'one-time-code'}
        autoCapitalize={recovery ? 'characters' : 'none'}
        autoCorrect="off"
        spellCheck={false}
        pattern={recovery ? undefined : '[0-9 ]{6,7}'}
        maxLength={recovery ? 24 : 7}
        placeholder={recovery ? 'XXXXX-XXXXX' : '6 digits'}
        required
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        aria-describedby={help ? `${id}-help` : undefined}
        style={inputStyle}
      />
      {help && <span id={`${id}-help`} className="field-hint">{help}</span>}
    </div>
  );
}
