import { Routes, Route, Navigate } from 'react-router-dom';
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

export default function App() {
  const { isAuthenticated, isLoading } = useAuth();

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

      {/* Protected routes */}
      <Route
        path="*"
        element={
          <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
            <Header />
            <Routes>
              <Route path="/quote" element={<QuoteBuilder />} />
              <Route path="/admin" element={<AdminPanel />} />
              <Route path="/dashboard" element={isAuthenticated ? <CustomerDashboard /> : <Navigate to="/login" />} />
              <Route path="/checkout/:quoteId" element={isAuthenticated ? <CheckoutPage /> : <Navigate to="/login" />} />
              <Route path="/orders/:orderId" element={isAuthenticated ? <OrderTrackingPage /> : <Navigate to="/login" />} />
              <Route path="/orders/:orderId/traveler" element={isAuthenticated ? <JobTravelerPage /> : <Navigate to="/login" />} />
            </Routes>
          </div>
        }
      />
    </Routes>
  );
}
