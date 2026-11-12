import React, { createContext, useState, useEffect, useCallback } from 'react';
import { api, setCsrfToken, setSessionEndedHandler, setEnrolmentRequiredHandler } from './api';
import { setAccountVerified } from './security';
import { notePendingCheckout, clearCheckoutDraft } from './returnTo';

export const AuthContext = createContext(null);

/**
 * Who is signed in.
 *
 * The session itself is an httpOnly cookie that page script cannot read, so on
 * load the page asks the server (/api/auth/session) who the cookie belongs to.
 * The answer carries the account (name, role, whether its email is confirmed)
 * and the CSRF token for this session. Nothing about the session is kept in
 * localStorage or sessionStorage.
 *
 * `isLoading` is true until that first answer arrives; guarded pages wait for
 * it. Public pages never wait on auth, so prerendered markup and the first
 * client render stay identical.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [verificationEnforced, setVerificationEnforced] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  // True from the moment the server says this browser's session is over until the next sign-in:
  // the sign-in page uses it to say why the buyer is looking at it again.
  const [sessionEnded, setSessionEnded] = useState(false);

  const apply = useCallback((session) => {
    const account = session && (session.authenticated !== false) ? session.user || null : null;
    setUser(account);
    setCsrfToken(account ? session.csrfToken : null);
    setAccountVerified(Boolean(account && account.emailVerified));
    if (session && typeof session.verificationEnforced === 'boolean') setVerificationEnforced(session.verificationEnforced);
    return account;
  }, []);

  /** Ask the server again (after confirming an email, switching on two-step sign-in, …). */
  const refresh = useCallback(async () => {
    try { return apply(await api.getSession()); } catch { return null; }
  }, [apply]);

  useEffect(() => {
    // The token used to be kept in localStorage. Remove any left over from an earlier visit.
    try { localStorage.removeItem('authToken'); } catch { /* private mode */ }
    setSessionEndedHandler(() => { setSessionEnded(true); apply(null); });
    // An admin request was refused because two-step sign-in is not on: read the account again
    // (the admin page then shows the enrolment screen and nothing else) and go there.
    setEnrolmentRequiredHandler(() => {
      api.getSession().then(apply).catch(() => {});
      if (typeof window !== 'undefined' && window.location.pathname !== '/admin') window.location.assign('/admin');
    });
    let alive = true;
    api.getSession()
      .then((s) => { if (alive) apply(s); })
      .catch(() => { if (alive) apply(null); })
      .finally(() => { if (alive) setIsLoading(false); });
    return () => { alive = false; setSessionEndedHandler(null); setEnrolmentRequiredHandler(null); };
  }, [apply]);

  /** After a successful sign-in or registration: `session` is the server's answer. */
  const login = useCallback((session) => { setSessionEnded(false); return apply({ ...session, authenticated: true }); }, [apply]);

  /** Ends the session on the server (the token stops working everywhere), then here. */
  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* signed out locally regardless */ }
    // A deliberate sign-out on this browser: forget where its checkout was and what was typed there.
    notePendingCheckout(null);
    clearCheckoutDraft();
    apply(null);
  }, [apply]);

  const isAuthenticated = !!user;

  return (
    <AuthContext.Provider value={{ user, login, logout, refresh, isAuthenticated, isLoading, verificationEnforced, sessionEnded }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
