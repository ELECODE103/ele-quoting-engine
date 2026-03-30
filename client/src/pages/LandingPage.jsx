import { useNavigate } from 'react-router-dom';

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div style={{ minHeight: '100vh', background: '#fff' }}>
      {/* ─── Nav ─── */}
      <nav style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 40px', maxWidth: 1280, margin: '0 auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <span style={{
            fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700,
            color: 'var(--text-primary)', letterSpacing: '-0.5px',
          }}>
            Nord MFG
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            className="btn btn-ghost"
            onClick={() => navigate('/login')}
            style={{ fontSize: 13 }}
          >
            Sign In
          </button>
          <button
            className="btn btn-primary"
            onClick={() => navigate('/')}
            style={{ fontSize: 13 }}
          >
            Get Instant Quote
          </button>
        </div>
      </nav>

      {/* ─── Hero ─── */}
      <section style={{
        padding: '80px 40px 60px',
        maxWidth: 1280, margin: '0 auto',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 60, alignItems: 'center',
      }}>
        <div>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '6px 14px', borderRadius: 20,
            background: 'var(--accent-light)', color: 'var(--accent)',
            fontSize: 13, fontWeight: 600, marginBottom: 24,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)' }} />
            Now accepting orders
          </div>

          <h1 style={{
            fontFamily: 'var(--font-display)', fontSize: 48, fontWeight: 700,
            color: 'var(--text-primary)', lineHeight: 1.15,
            letterSpacing: '-1.5px', marginBottom: 20,
          }}>
            3D Printing,<br />Quoted Instantly
          </h1>

          <p style={{
            fontSize: 18, color: 'var(--text-muted)', lineHeight: 1.7,
            marginBottom: 36, maxWidth: 480,
          }}>
            Upload your STL or STEP file and get real pricing in seconds. FDM and resin printing with instant DFM analysis, no sales calls required.
          </p>

          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 40 }}>
            <button
              className="btn btn-primary btn-lg"
              onClick={() => navigate('/')}
            >
              Start Your Quote
            </button>
            <button
              className="btn btn-outline btn-lg"
              onClick={() => {
                document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              How It Works
            </button>
          </div>

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            {['STL', 'STEP', '3MF', 'IGES'].map((f) => (
              <span key={f} style={{
                fontSize: 12, padding: '5px 12px', borderRadius: 6,
                background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
                color: 'var(--text-muted)', fontWeight: 500, fontFamily: 'var(--font-mono)',
              }}>
                .{f.toLowerCase()}
              </span>
            ))}
          </div>
        </div>

        {/* Hero visual — Upload card mockup */}
        <div style={{
          background: 'var(--bg-secondary)', borderRadius: 20, padding: 40,
          border: '1px solid var(--border-primary)',
          boxShadow: 'var(--shadow-xl)',
        }}>
          <div style={{
            border: '2px dashed var(--border-primary)', borderRadius: 16,
            padding: '48px 32px', textAlign: 'center',
            background: '#fff',
          }}>
            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" style={{ marginBottom: 20, opacity: 0.8 }}>
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600,
              color: 'var(--text-primary)', marginBottom: 8,
            }}>
              Upload Your Parts
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Drag & drop your 3D files here<br />
              Instant geometry analysis and pricing
            </div>
          </div>

          {/* Fake result preview */}
          <div style={{
            marginTop: 20, display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', padding: '14px 16px',
            background: '#fff', borderRadius: 10,
            border: '1px solid var(--border-primary)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: 'var(--accent-light)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16,
              }}>▲</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>bracket-v2.stl</div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>PLA+ FDM · 0.2mm layers</div>
              </div>
            </div>
            <div style={{
              fontSize: 18, fontWeight: 700, color: 'var(--accent)',
              fontFamily: 'var(--font-display)',
            }}>$4.80</div>
          </div>
        </div>
      </section>

      {/* ─── Trust bar ─── */}
      <section style={{
        padding: '32px 40px',
        borderTop: '1px solid var(--border-subtle)',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg-secondary)',
      }}>
        <div style={{
          maxWidth: 1280, margin: '0 auto',
          display: 'flex', justifyContent: 'center', gap: 48,
          flexWrap: 'wrap', alignItems: 'center',
        }}>
          {[
            { value: '<24h', label: 'Average turnaround' },
            { value: '0.1mm', label: 'Layer resolution' },
            { value: '100%', label: 'DFM analysis included' },
            { value: '$0', label: 'No setup fees' },
          ].map((s, i) => (
            <div key={i} style={{ textAlign: 'center' }}>
              <div style={{
                fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700,
                color: 'var(--accent)',
              }}>{s.value}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ─── Technologies ─── */}
      <section style={{
        padding: '80px 40px', maxWidth: 1280, margin: '0 auto',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 60 }}>
          <h2 style={{
            fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 700,
            color: 'var(--text-primary)', letterSpacing: '-1px', marginBottom: 12,
          }}>
            3D Printing Technologies
          </h2>
          <p style={{ fontSize: 16, color: 'var(--text-muted)', maxWidth: 560, margin: '0 auto' }}>
            From rapid prototypes to end-use parts, choose the technology that fits your project.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {[
            {
              title: 'FDM Printing',
              subtitle: 'Fused Deposition Modeling',
              desc: 'Layer-by-layer thermoplastic extrusion. Ideal for functional prototypes, jigs, fixtures, and cost-effective production parts.',
              materials: ['PLA', 'PLA+', 'ABS', 'PETG', 'TPU', 'Nylon'],
              icon: (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M12 2v6m0 8v6M2 12h6m8 0h6" />
                  <circle cx="12" cy="12" r="3" />
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                </svg>
              ),
            },
            {
              title: 'Resin Printing',
              subtitle: 'SLA / DLP',
              desc: 'High-resolution UV-cured resin for smooth surface finishes and fine detail. Perfect for visual models, dental, jewelry, and precision parts.',
              materials: ['Standard Resin', 'Tough Resin', 'Flexible Resin', 'Castable'],
              icon: (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M12 3v18" />
                  <path d="M5 6l7-3 7 3" />
                  <path d="M5 6v12l7 3 7-3V6" />
                </svg>
              ),
            },
          ].map((tech, i) => (
            <div key={i} className="card fade-up" style={{
              padding: 36, animationDelay: `${i * 150}ms`,
              transition: 'all 0.3s', cursor: 'default',
            }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--accent)';
                e.currentTarget.style.boxShadow = 'var(--shadow-lg)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-primary)';
                e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
              }}
            >
              <div style={{ marginBottom: 16 }}>{tech.icon}</div>
              <h3 style={{
                fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700,
                color: 'var(--text-primary)', marginBottom: 4,
              }}>
                {tech.title}
              </h3>
              <div style={{
                fontSize: 13, color: 'var(--accent)', fontWeight: 500, marginBottom: 12,
              }}>
                {tech.subtitle}
              </div>
              <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 16 }}>
                {tech.desc}
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {tech.materials.map((m) => (
                  <span key={m} style={{
                    fontSize: 12, padding: '4px 10px', borderRadius: 6,
                    background: 'var(--bg-secondary)', color: 'var(--text-muted)',
                    fontWeight: 500,
                  }}>
                    {m}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ─── How It Works ─── */}
      <section id="how-it-works" style={{
        padding: '80px 40px',
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border-subtle)',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <div style={{ maxWidth: 1280, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 60 }}>
            <h2 style={{
              fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 700,
              color: 'var(--text-primary)', letterSpacing: '-1px', marginBottom: 12,
            }}>
              How It Works
            </h2>
            <p style={{ fontSize: 16, color: 'var(--text-muted)', maxWidth: 480, margin: '0 auto' }}>
              From file upload to delivered parts in three simple steps.
            </p>
          </div>

          <div className="grid-3">
            {[
              {
                step: '01',
                title: 'Upload Your File',
                desc: 'Drag and drop your STL, STEP, or 3MF file. Our engine parses the geometry automatically, extracting volume, surface area, and feature details.',
              },
              {
                step: '02',
                title: 'Configure & Review',
                desc: 'Choose your material, layer height, and infill. Review instant DFM checks that flag printability issues before you order.',
              },
              {
                step: '03',
                title: 'Order & Receive',
                desc: 'Confirm your quote, complete checkout, and receive production-quality parts shipped to your door. Track progress in real time.',
              },
            ].map((item, i) => (
              <div key={i} className="fade-up" style={{
                padding: 32, background: '#fff',
                borderRadius: 16, border: '1px solid var(--border-primary)',
                boxShadow: 'var(--shadow-sm)',
                animationDelay: `${i * 120}ms`,
              }}>
                <div style={{
                  fontFamily: 'var(--font-display)', fontSize: 40, fontWeight: 700,
                  color: 'var(--accent)', opacity: 0.3, marginBottom: 16,
                }}>{item.step}</div>
                <h3 style={{
                  fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700,
                  color: 'var(--text-primary)', marginBottom: 8,
                }}>
                  {item.title}
                </h3>
                <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Features ─── */}
      <section style={{ padding: '80px 40px', maxWidth: 1280, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 60 }}>
          <h2 style={{
            fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 700,
            color: 'var(--text-primary)', letterSpacing: '-1px', marginBottom: 12,
          }}>
            Built for Engineers
          </h2>
          <p style={{ fontSize: 16, color: 'var(--text-muted)', maxWidth: 520, margin: '0 auto' }}>
            Real geometry analysis, not estimation. Every quote is calculated from your actual part data.
          </p>
        </div>

        <div className="grid-3">
          {[
            {
              icon: '⚡',
              title: 'Real Geometry Parsing',
              desc: 'STL and STEP files are parsed with OpenCascade WASM. Volume, surface area, bounding box, and feature count extracted automatically.',
            },
            {
              icon: '🔍',
              title: 'Instant DFM Analysis',
              desc: 'Automated design-for-manufacturability checks flag issues like thin walls, unsupported overhangs, and minimum feature sizes before you order.',
            },
            {
              icon: '💰',
              title: 'Transparent Pricing',
              desc: 'See exactly how your price is calculated: material volume, print time, support structures, and finish cost with full per-unit breakdown.',
            },
            {
              icon: '📐',
              title: '3D Part Preview',
              desc: 'Interactive WebGL viewer lets you orbit, zoom, and inspect your part in 3D before committing to a print.',
            },
            {
              icon: '📦',
              title: 'Volume Discounts',
              desc: 'Quantity pricing is calculated automatically. Order more parts and see your per-unit cost drop in real time.',
            },
            {
              icon: '🚀',
              title: 'Fast Turnaround',
              desc: 'Standard and rush lead times available. Pick the timeline that works for your project and see the price adjust instantly.',
            },
          ].map((f, i) => (
            <div key={i} className="fade-up" style={{
              padding: 28, animationDelay: `${i * 80}ms`,
            }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>{f.icon}</div>
              <h3 style={{
                fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700,
                color: 'var(--text-primary)', marginBottom: 8,
              }}>
                {f.title}
              </h3>
              <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                {f.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section style={{
        padding: '80px 40px',
        background: 'var(--bg-dark)',
        textAlign: 'center',
      }}>
        <h2 style={{
          fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 700,
          color: '#F8FAFC', letterSpacing: '-1px', marginBottom: 16,
        }}>
          Ready to get your parts printed?
        </h2>
        <p style={{
          fontSize: 16, color: '#94A3B8', marginBottom: 36,
          maxWidth: 480, margin: '0 auto 36px',
        }}>
          Upload your file and get an instant quote. No signup required.
        </p>
        <button
          className="btn btn-primary btn-lg"
          onClick={() => navigate('/')}
          style={{ fontSize: 16, padding: '16px 36px' }}
        >
          Get Your Instant Quote
        </button>
      </section>

      {/* ─── Footer ─── */}
      <footer style={{
        padding: '32px 40px',
        borderTop: '1px solid var(--border-subtle)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        maxWidth: 1280, margin: '0 auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700,
            color: 'var(--text-primary)',
          }}>
            Nord MFG
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            &copy; {new Date().getFullYear()} All rights reserved.
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          3D Printing Services &middot; FDM &middot; SLA/DLP
        </div>
      </footer>
    </div>
  );
}
