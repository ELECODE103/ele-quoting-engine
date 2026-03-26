import { useState } from 'react';
import Header from './components/Header';
import QuoteBuilder from './pages/QuoteBuilder';
import AdminPanel from './pages/AdminPanel';

export default function App() {
  const [page, setPage] = useState('quote');

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <Header page={page} onPageChange={setPage} />
      {page === 'quote' && <QuoteBuilder />}
      {page === 'admin' && <AdminPanel />}
    </div>
  );
}
