import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './utils/authContext';
import Header from './components/Header';
import QuoteBuilder from './pages/QuoteBuilder';
import AdminPanel from './pages/AdminPanel';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import CustomerDashboard from './pages/CustomerDashboard';
import CheckoutPage from './pages/CheckoutPage';
import OrderTrackingPage from './pages/OrderTrackingPage';
import JobTravelerPage from './pages/JobTravelerPage';
import LandingPage from './pages/LandingPage';
import ServicePage from './pages/ServicePage';
import MaterialsPage from './pages/MaterialsPage';
import QualityPage from './pages/QualityPage';
import AboutPage from './pages/AboutPage';
import RfqPage from './pages/RfqPage';
import FirmQuotePage from './pages/FirmQuotePage';
import { authPath } from './utils/returnTo';

// Guests are sent to sign in and brought back to the page they asked for.
function RequireAuth({ children }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (isAuthenticated) return children;
  return <Navigate to={authPath('/login', location.pathname + location.search)} replace />;
}

export default function App() {
  const { isLoading } = useAuth();

  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/" element={<LandingPage />} />
      <Route path="/machining" element={<ServicePage slug="machining" />} />
      <Route path="/routing" element={<ServicePage slug="routing" />} />
      <Route path="/3d-printing" element={<ServicePage slug="3d-printing" />} />
      <Route path="/materials" element={<MaterialsPage />} />
      <Route path="/quality" element={<QualityPage />} />
      <Route path="/about" element={<AboutPage />} />
      <Route path="/rfq" element={<RfqPage />} />
      <Route path="/rfq/:quoteId" element={<RfqPage />} />
      <Route path="/firm-quote/:token" element={<FirmQuotePage />} />

      {/* Protected routes */}
      <Route
        path="*"
        element={
          <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
            <Header />
            <Routes>
              <Route path="/quote" element={<QuoteBuilder />} />
              <Route path="/admin" element={<AdminPanel />} />
              <Route path="/dashboard" element={<RequireAuth><CustomerDashboard /></RequireAuth>} />
              <Route path="/checkout/:quoteId" element={<RequireAuth><CheckoutPage /></RequireAuth>} />
              <Route path="/orders/:orderId" element={<RequireAuth><OrderTrackingPage /></RequireAuth>} />
              <Route path="/orders/:orderId/traveler" element={<RequireAuth><JobTravelerPage /></RequireAuth>} />
            </Routes>
          </div>
        }
      />
    </Routes>
  );
}
