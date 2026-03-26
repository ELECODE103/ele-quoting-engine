import { useNavigate } from 'react-router-dom';

export default function LandingPage() {
  const navigate = useNavigate();

  const features = [
    {
      title: 'Sheet Metal',
      description: 'Laser cutting, bending, and welding for precision metal parts',
      icon: '⬡',
    },
    {
      title: 'CNC Machining',
      description: 'Multi-axis milling and turning for complex geometries',
      icon: '⚙',
    },
    {
      title: '3D Printing',
      description: 'FDM, SLS, and resin printing for rapid prototyping',
      icon: '📦',
    },
  ];

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      {/* Hero Section */}
      <div style={{
        padding: '120px 32px',
        textAlign: 'center',
        background: 'linear-gradient(135deg, var(--bg-primary) 0%, var(--bg-secondary) 100%)',
        borderBottom: '1px solid var(--border-primary)',
      }}>
        <h1 style={{
          fontSize: 48,
          fontWeight: 700,
          color: 'var(--text-primary)',
          marginBottom: 16,
          maxWidth: 800,
          margin: '0 auto 16px',
          lineHeight: 1.2,
        }}>
          Instant Quotes for Custom Parts
        </h1>

        <p style={{
          fontSize: 16,
          color: 'var(--text-secondary)',
          marginBottom: 48,
          maxWidth: 600,
          margin: '0 auto 48px',
          lineHeight: 1.6,
        }}>
          Get instant pricing for sheet metal, CNC machining, and 3D printing. No sales calls, no waiting. Just upload your design and get a quote in seconds.
        </p>

        <button
          className="btn btn-primary btn-lg"
          onClick={() => navigate('/')}
          style={{
            fontSize: 14,
            padding: '16px 32px',
          }}
        >
          Get a Quote Now
        </button>
      </div>

      {/* Features Section */}
      <div style={{
        padding: '80px 32px',
        maxWidth: 1200,
        margin: '0 auto',
      }}>
        <h2 style={{
          fontSize: 28,
          fontWeight: 700,
          color: 'var(--text-primary)',
          textAlign: 'center',
          marginBottom: 60,
        }}>
          Our Manufacturing Processes
        </h2>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 24,
        }}>
          {features.map((feature) => (
            <div
              key={feature.title}
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-lg)',
                padding: 32,
                textAlign: 'center',
                transition: 'all 0.3s',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--accent)';
                e.currentTarget.style.background = 'var(--bg-secondary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-primary)';
                e.currentTarget.style.background = 'var(--bg-card)';
              }}
            >
              <div style={{
                fontSize: 48,
                marginBottom: 16,
              }}>
                {feature.icon}
              </div>

              <h3 style={{
                fontSize: 16,
                fontWeight: 600,
                color: 'var(--text-primary)',
                marginBottom: 12,
              }}>
                {feature.title}
              </h3>

              <p style={{
                fontSize: 13,
                color: 'var(--text-muted)',
                lineHeight: 1.6,
              }}>
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* CTA Section */}
      <div style={{
        padding: '80px 32px',
        background: 'var(--accent-bg)',
        borderTop: '1px solid var(--border-primary)',
        borderBottom: '1px solid var(--border-primary)',
        textAlign: 'center',
      }}>
        <h2 style={{
          fontSize: 28,
          fontWeight: 700,
          color: 'var(--text-primary)',
          marginBottom: 16,
        }}>
          Ready to get started?
        </h2>

        <p style={{
          fontSize: 14,
          color: 'var(--text-secondary)',
          marginBottom: 32,
          maxWidth: 600,
          margin: '0 auto 32px',
        }}>
          Upload your CAD file and receive an instant quote. No signup required for quotes.
        </p>

        <button
          className="btn btn-primary btn-lg"
          onClick={() => navigate('/')}
        >
          Get a Quote
        </button>
      </div>

      {/* Footer */}
      <div style={{
        padding: '40px 32px',
        textAlign: 'center',
        borderTop: '1px solid var(--border-primary)',
      }}>
        <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          © 2026 Instant Quote. All rights reserved.
        </p>
      </div>
    </div>
  );
}
