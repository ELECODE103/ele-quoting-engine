# Instant Quote SaaS Platform

A production-ready instant quoting platform for custom sheet metal and CNC parts. Upload STEP/STL files, get real geometry analysis, DFM checks, and instant pricing.

## Architecture

```
instant-quote-saas/
├── server/                    # Express.js backend
│   ├── index.js               # Server entry point
│   ├── config/
│   │   ├── defaults.js        # Default materials, finishes, pricing rules
│   │   └── seed.js            # Database seeder
│   ├── models/
│   │   └── db.js              # JSON file database (swap for PostgreSQL in production)
│   ├── parsers/
│   │   └── fileParser.js      # STEP/STL geometry parser (OpenCascade WASM)
│   ├── routes/
│   │   └── api.js             # All API endpoints
│   └── services/
│       └── pricingEngine.js   # Quote calculation engine
├── client/                    # React + Vite frontend
│   ├── src/
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   ├── components/
│   │   │   ├── Header.jsx
│   │   │   ├── ThreeViewer.jsx     # Three.js 3D mesh renderer
│   │   │   ├── DFMPanel.jsx        # DFM analysis display
│   │   │   ├── PartConfigurator.jsx # Material/finish/qty selector
│   │   │   └── OrderSummary.jsx     # Quote summary sidebar
│   │   ├── pages/
│   │   │   ├── QuoteBuilder.jsx     # Main quoting interface
│   │   │   └── AdminPanel.jsx       # Admin: materials, pricing, quotes
│   │   ├── utils/
│   │   │   ├── api.js               # API client
│   │   │   └── format.js            # Formatting helpers
│   │   └── styles/
│   │       └── global.css
│   └── index.html
├── data/                      # JSON database files (auto-created)
├── uploads/                   # Uploaded CAD files (auto-created)
└── package.json
```

## Features

### Geometry Parsing (Real, not simulated)
- **STEP/STP files**: Parsed with `occt-import-js` (OpenCascade compiled to WebAssembly)
- **STL files**: Binary and ASCII parser with full mesh analysis
- **IGES files**: Supported via OpenCascade
- Extracts: bounding box, surface area, volume, triangle count, estimated holes/bends/slots, flat pattern dimensions, cut perimeter

### DFM Analysis
- Minimum feature size check
- Maximum part size vs. laser bed
- Hole-to-edge distance validation
- Bend feasibility (thickness limits, bend relief)
- Minimum hole diameter check
- Nesting compatibility
- Aspect ratio warnings
- Overall manufacturability score

### Pricing Engine
- **Material cost**: Weight × price/kg (configurable per material)
- **Laser cutting**: Perimeter × rate × thickness^exponent
- **Bending**: Per-bend cost with thickness multiplier
- **Holes/features**: Per-hole and per-slot costs
- **Finishes**: Per-part base + per-area cost
- **Volume discounts**: 9 configurable tiers (1 to 1000+ units)
- **Nesting savings**: Automatic discount for multi-part orders
- **Margin**: Configurable target margin percentage
- **Lead time surcharges**: 4 tiers (standard → same-day)
- **Shipping**: Base rate + per-kg rate

### Admin Panel
- CRUD for materials (7 pre-loaded: mild steel, 304/316 stainless, 5052/6061 aluminum, copper, brass)
- CRUD for finishes (9 options: raw, deburr, powder coat, anodize, zinc plate)
- Lead time management with configurable multipliers
- Full pricing engine configuration (all rates, discounts, margins)
- Quote history with stats dashboard

### 3D Preview
- Three.js-based mesh renderer
- Mouse orbit controls (drag to rotate, scroll to zoom)
- Wireframe overlay + edge highlighting
- Auto-centering and scaling
- Material-colored rendering

## Quick Start

```bash
# Install dependencies
npm install
cd client && npm install && cd ..

# Start development (server + client concurrently)
npm run dev

# Or start separately:
npm run server    # Express API on :3000
npm run client    # Vite dev server on :3001 (proxied to :3000)
```

Open http://localhost:3001 for the app, or http://localhost:3000/api for the API directly.

## API Endpoints

### Public
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/upload` | Upload CAD files (multipart form, field: `files`) |
| POST | `/api/quote` | Calculate instant quote |
| GET | `/api/quote/:id` | Retrieve a saved quote |
| GET | `/api/materials` | List active materials |
| GET | `/api/finishes` | List active finishes |
| GET | `/api/lead-times` | List active lead times |

### Admin
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/PUT/POST/DELETE | `/api/admin/materials[/:id]` | Materials CRUD |
| GET/PUT/POST | `/api/admin/finishes[/:id]` | Finishes CRUD |
| GET/PUT | `/api/admin/lead-times/:id` | Lead times management |
| GET/PUT | `/api/admin/pricing` | Pricing engine rules |
| GET | `/api/admin/quotes` | All quotes |
| GET | `/api/admin/stats` | Dashboard stats |

### Quote Request Body
```json
{
  "parts": [
    {
      "partId": "uuid-from-upload",
      "materialSlug": "mild-steel",
      "grade": "A36 / 1008",
      "thicknessMm": 1.5,
      "finishSlug": "deburr",
      "quantity": 10
    }
  ],
  "leadTimeSlug": "expedited"
}
```

## Production Deployment

### Swap database
Replace `server/models/db.js` with PostgreSQL/MySQL adapter (same interface: `getAll`, `getById`, `insert`, `update`, `delete`).

### Add authentication
- Add JWT/session auth middleware for admin routes
- Add user accounts for quote history
- Consider API key auth for programmatic access

### Add payment
- Integrate Stripe Checkout for the "Proceed to Checkout" flow
- Webhook handler for order confirmation

### Environment variables
```env
PORT=3000
NODE_ENV=production
DATABASE_URL=postgres://...
STRIPE_SECRET_KEY=sk_...
JWT_SECRET=...
```

### Build and deploy
```bash
npm run build          # Build client
npm run start          # Start production server (serves client from dist/)
```

## Customization

### Adding a new material
1. Admin Panel → Materials → Add Material (or via API)
2. Configure: name, slug, category, grades (with density), thicknesses, price/kg, color

### Adjusting pricing
1. Admin Panel → Pricing Rules
2. Modify laser cut rates, bend costs, margins, volume discounts
3. Changes take effect immediately on new quotes

### Adding file format support
1. Add parser function in `server/parsers/fileParser.js`
2. Add extension to `multer` filter in `server/routes/api.js`
3. The parser must return the same geometry shape: `{ boundingBox, surfaceArea, volume, triangleCount, estimatedThickness, flatWidth, flatHeight, flatArea, estimatedPerimeter, estimatedHoles, estimatedBends, units, meshData }`

<!-- deploy trigger -->
