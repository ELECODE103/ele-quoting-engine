import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './utils/authContext';
import useHeadSync from './seo/useHeadSync';
import Header from './components/Header';
// Public (marketing) pages are in the main bundle: they are small, they are
// what search engines and first-time visitors load, and they are prerendered
// to static HTML at build time (scripts/seo/prerender.mjs) and hydrated.
import LandingPage from './pages/LandingPage';
import ServicePage from './pages/ServicePage';
import MaterialsPage from './pages/MaterialsPage';
import MaterialPage from './pages/MaterialPage';
import QualityPage from './pages/QualityPage';
import AboutPage from './pages/AboutPage';
import RfqPage from './pages/RfqPage';
import ReplacementPartsPage from './pages/ReplacementPartsPage';
import PartsPage from './pages/PartsPage';
import FoodContactPage from './pages/FoodContactPage';
import NotFoundPage from './pages/NotFoundPage';
import { authPath } from './utils/returnTo';

// App pages are split out so three.js, the quote builder and the admin panel
// are never downloaded by someone reading a marketing page.
const QuoteBuilder = lazy(() => import('./pages/QuoteBuilder'));
const AdminPanel = lazy(() => import('./pages/AdminPanel'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const CustomerDashboard = lazy(() => import('./pages/CustomerDashboard'));
const CheckoutPage = lazy(() => import('./pages/CheckoutPage'));
const OrderTrackingPage = lazy(() => import('./pages/OrderTrackingPage'));
const JobTravelerPage = lazy(() => import('./pages/JobTravelerPage'));
const FirmQuotePage = lazy(() => import('./pages/FirmQuotePage'));
const FirmQuoteReturnPage = lazy(() => import('./pages/FirmQuoteReturnPage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
const VerifyEmailPage = lazy(() => import('./pages/VerifyEmailPage'));
const AdminSetupPage = lazy(() => import('./pages/AdminSetupPage'));

function Spinner() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="spinner" />
    </div>
  );
}

/** App chrome (shared header) around a lazily loaded app page. */
function AppShell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <Header />
      <div id="content" tabIndex={-1}><Suspense fallback={<Spinner />}>{children}</Suspense></div>
    </div>
  );
}

/**
 * Waits for the saved session to be read, then sends guests to sign in and
 * brings them back to the page they asked for.
 */
function Protected({ children, adminOnly = false }) {
  const { isAuthenticated, isLoading, user } = useAuth();
  const location = useLocation();
  if (isLoading) return <Spinner />;
  // The API enforces the admin role; this only keeps a signed-in customer from landing on an empty admin shell.
  if (isAuthenticated && adminOnly && user?.role !== 'admin') return <Navigate to="/dashboard" replace />;
  if (isAuthenticated) return children;
  return <Navigate to={authPath('/login', location.pathname + location.search)} replace />;
}

export default function App() {
  useHeadSync();

  // Note: public routes must render the same markup on the server and on the
  // first client render, so nothing here may wait on auth state.
  return (
    <Routes>
      {/* Public, prerendered */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/machining" element={<ServicePage slug="machining" />} />
      <Route path="/routing" element={<ServicePage slug="routing" />} />
      <Route path="/3d-printing" element={<ServicePage slug="3d-printing" />} />
      <Route path="/materials" element={<MaterialsPage />} />
      <Route path="/materials/:slug" element={<MaterialPage />} />
      <Route path="/replacement-parts" element={<ReplacementPartsPage />} />
      <Route path="/parts" element={<PartsPage />} />
      <Route path="/food-contact" element={<FoodContactPage />} />
      <Route path="/quality" element={<QualityPage />} />
      <Route path="/about" element={<AboutPage />} />
      <Route path="/rfq" element={<RfqPage />} />
      <Route path="/rfq/:quoteId" element={<RfqPage />} />

      {/* App, client-rendered, noindex */}
      <Route path="/login" element={<Suspense fallback={<Spinner />}><LoginPage /></Suspense>} />
      <Route path="/register" element={<Suspense fallback={<Spinner />}><RegisterPage /></Suspense>} />
      <Route path="/forgot-password" element={<Suspense fallback={<Spinner />}><ForgotPasswordPage /></Suspense>} />
      <Route path="/reset-password" element={<Suspense fallback={<Spinner />}><ResetPasswordPage /></Suspense>} />
      <Route path="/verify-email" element={<Suspense fallback={<Spinner />}><VerifyEmailPage /></Suspense>} />
      {/* Where the card page sends a firm-quote buyer back to. Its address carries no quote link. */}
      <Route path="/firm-quote/return" element={<Suspense fallback={<Spinner />}><FirmQuoteReturnPage /></Suspense>} />
      <Route path="/firm-quote/:token" element={<Suspense fallback={<Spinner />}><FirmQuotePage /></Suspense>} />
      <Route path="/quote" element={<AppShell><QuoteBuilder /></AppShell>} />
      <Route path="/admin" element={<AppShell><Protected adminOnly><AdminPanel /></Protected></AppShell>} />
      <Route path="/admin/setup" element={<Suspense fallback={<Spinner />}><AdminSetupPage /></Suspense>} />
      <Route path="/dashboard" element={<AppShell><Protected><CustomerDashboard /></Protected></AppShell>} />
      <Route path="/checkout/:quoteId" element={<AppShell><Protected><CheckoutPage /></Protected></AppShell>} />
      <Route path="/orders/:orderId" element={<AppShell><Protected><OrderTrackingPage /></Protected></AppShell>} />
      <Route path="/orders/:orderId/traveler" element={<AppShell><Protected><JobTravelerPage /></Protected></AppShell>} />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
