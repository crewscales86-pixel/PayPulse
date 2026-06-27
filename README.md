# Created by Lukas Hines (PayPulse)
# Last updated: 2026-06-26

## Project Structure
```
PayPulse/
├── server.js          # Express API + auth + webhooks + Stripe
├── db.js              # Database layer (SQLite local / PostgreSQL prod)
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── public/
│   └── index.html     # Single-page React app (dashboard, kanban, settings, metrics, admin)
└── paypulse.db        # SQLite (local dev only, gitignored)
```

## Quick Start (Local)
```bash
npm install
rm -f paypulse.db
node server.js
# → http://localhost:3000
# → Admin: admin@paypulse.co / admin123
```

## Deploy to Production
```bash
# Using Docker:
docker-compose up -d

# Or deploy to Railway/Render with these env vars:
# NODE_ENV=production
# PORT=3000
# JWT_SECRET=<random-64-char>
# DATABASE_URL=postgresql://...
# BASE_URL=https://yourdomain.com
# STRIPE_SECRET_KEY=sk_live_xxx (optional)
```

## Admin Flow
1. Login as admin (`admin@paypulse.co` / `admin123`)
2. Click **"+ CREATE AGENCY"** in admin panel
3. Enter SMMA's email, password, company name, plan, processor
4. SMMA gets their own login + webhook URLs
5. SMMA adds their contractor clients
6. GHL webhook triggers auto-charge per appointment
7. Track Facebook ad metrics per client

## SMMA Flow
1. Login with credentials from admin
2. See kanban CRM (New → Active → At Risk → Paused)
3. Add clients manually or via GHL webhook
4. Charge clients (one-click or auto via webhook)
5. Add Facebook ad metrics per client
6. View revenue, CPL, CPA, CTR on Metrics page

## API Endpoints
- `POST /api/auth/login` — Login
- `GET /api/auth/me` — Current user info + subscription
- `POST /api/customers` — Create customer
- `POST /api/customers/:id/charge` — Charge customer
- `POST /api/customers/:id/ad-metrics` — Add Facebook ad data
- `GET /api/customers/:id/ad-metrics` — Get ad metrics
- `GET /api/stats` — Dashboard stats
- `GET /api/metrics` — Revenue charts + top customers
- `POST /api/admin/agencies` — Admin: create SMMA account
- `GET /api/admin/agencies` — Admin: list all SMMAs
- `POST /webhook/ghl/:secret` — GHL trigger endpoint
- `POST /webhook/stripe/:secret` — Stripe webhooks

## Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | JWT signing secret |
| `DATABASE_URL` | Prod | PostgreSQL connection string |
| `BASE_URL` | Yes | Public URL for webhook links |
| `STRIPE_SECRET_KEY` | No | For SMMA subscription billing |
| `STRIPE_PRICE_STANDARD` | No | Stripe price ID for $97/mo |
| `STRIPE_PRICE_PRO` | No | Stripe price ID for $297/mo |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signing secret |
