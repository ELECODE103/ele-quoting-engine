import { Link } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import brand from '../brand';

/** Shown for any URL the router does not know. The server sends it with a 404 status. */
export default function NotFoundPage() {
  return (
    <PublicLayout>
      <section className="section">
        <div className="pub-wrap" style={{ maxWidth: 680 }}>
          <div className="eyebrow" style={{ marginBottom: 14 }}>404</div>
          <h1 className="display" style={{ marginBottom: 16 }}>That page isn't here.</h1>
          <p className="lede" style={{ marginBottom: 28 }}>
            The link may be old or mistyped. Start from one of the pages below, or call {brand.phone}.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link to="/" className="btn btn-primary">Home</Link>
            <Link to="/materials" className="btn btn-ghost">Materials</Link>
            <Link to="/machining" className="btn btn-ghost">CNC machining</Link>
            <Link to="/routing" className="btn btn-ghost">CNC routing</Link>
            <Link to="/replacement-parts" className="btn btn-ghost">Replacement parts</Link>
            <Link to="/quote" className="btn btn-ghost">Instant quote</Link>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
