import { forwardRef, useEffect, useRef } from 'react';

const KIND = {
  error: { className: 'auth-error', role: 'alert' },
  ok: { className: 'auth-ok', role: 'status' },
  info: { className: 'verify-box', role: 'status' },
  warn: { className: 'gate-box', role: 'status' },
};

/**
 * One message box, in the four looks the site already has (error, done,
 * something to do, heads-up). `role` follows the kind: an error is an alert
 * (read out at once), the rest are status lines (read out when the reader is
 * idle).
 */
const Notice = forwardRef(function Notice({ kind = 'error', children, className = '', role, ...rest }, ref) {
  const k = KIND[kind] || KIND.error;
  return (
    <div ref={ref} className={`${k.className} notice${className ? ` ${className}` : ''}`} role={role || k.role} {...rest}>
      {children}
    </div>
  );
});
export default Notice;

/**
 * The error at the top of (or just above the button of) a form.
 *
 * When `error` changes to something, the box takes the keyboard focus, so a
 * person using a screen reader or a magnifier lands on what went wrong, and
 * the next Tab continues from there into the form. `error` is a string, or an
 * Error from utils/api.js; `children` are the next steps (links, a button).
 * `at` changes on every submission so the same message, shown twice in a row,
 * is announced twice.
 */
export function FormError({ error, at = 0, children, id, style }) {
  const box = useRef(null);
  const text = typeof error === 'string' ? error : error?.message || '';
  useEffect(() => { if (text && box.current) box.current.focus({ preventScroll: false }); }, [text, at]);
  if (!text) return null;
  return (
    <Notice kind="error" ref={box} id={id} tabIndex={-1} style={style}>
      {text}
      {children ? <div className="notice-actions">{children}</div> : null}
    </Notice>
  );
}
