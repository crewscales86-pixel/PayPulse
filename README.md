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
│   └── index.html     # Single-page React app (dashboard, kanban, settings, metrics, admin, ops)
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
# META_APP_ID=your_meta_app_id
# META_APP_SECRET=your_meta_app_secret
# META_REDIRECT_URI=https://yourdomain.com/api/meta/callback
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
5. Connect Meta Ads once for that agency
6. Map campaigns / ad sets to clients
7. View spend, CPL, CTR, booked appointments, and margin

## API Endpoints
- `POST /api/auth/login` — Login
- `GET /api/auth/me` — Current user info + subscription
- `POST /api/customers` — Create customer
- `POST /api/customers/:id/charge` — Charge customer
- `POST /api/customers/:id/credits` — Issue manual credit
- `GET /api/customers/:id/timeline` — Customer timeline
- `GET /api/customers/:id/notes` — Customer notes
- `POST /api/customers/:id/notes` — Add customer note
- `POST /api/customers/:id/ad-metrics` — Add Facebook ad data
- `GET /api/customers/:id/ad-metrics` — Get ad metrics
- `GET /api/stats` — Dashboard stats
- `GET /api/metrics` — Revenue charts + top customers
- `GET /api/alerts` — Dashboard alerts
- `GET /api/audit-logs` — Audit history
- `GET /api/webhook-events` — Webhook event history
- `GET /api/segments` — Saved segments
- `GET /api/export/:type` — CSV export
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
| `META_APP_ID` | Recommended for Meta | Platform-level Meta app ID |
| `META_APP_SECRET` | Recommended for Meta | Platform-level Meta app secret |
| `META_REDIRECT_URI` | Recommended for Meta | OAuth callback URL, usually `https://yourdomain.com/api/meta/callback` |
| `STRIPE_WEBHOOK_ROUTE_SECRET` | Yes | Secret path segment for Stripe webhook route |
| `STRIPE_WEBHOOK_SECRET` | Recommended | Stripe signature verification secret |
| `STRIPE_SECRET_KEY` | No | For SMMA subscription billing |
| `STRIPE_PRICE_STANDARD` | No | Stripe price ID for $97/mo |
| `STRIPE_PRICE_PRO` | No | Stripe price ID for $297/mo |
| `SMTP_HOST` | No | SMTP host for failed-charge / approval emails |
| `SMTP_PORT` | No | SMTP port |
| `SMTP_USER` | No | SMTP username |
| `SMTP_PASS` | No | SMTP password |
| `SMTP_FROM` | No | Sender address for app emails |

## New Ops Features
- Audit logs for agency, customer, settings, credit, refund, retry, and note activity
- Webhook event history with duplicate detection / idempotency
- Scheduled retry metadata on failed charges
- Customer timelines with notes, audit items, webhook events, appointments, and charges
- Internal + recurring customer notes
- Manual credits and refund flow
- Saved customer segments and CSV exports
- Dashboard alerts for failures, retries, missing cards, webhook issues, and due follow-ups

## Meta Setup Model
- PayPulse uses one platform-level Meta app configured by the PayPulse owner on Railway.
- Agencies do not enter Meta app secrets.
- Each agency logs into its own PayPulse account, clicks `Connect Meta Ads`, selects its ad account, and maps campaigns or ad sets to clients.
- This keeps agency onboarding simple while still allowing native Meta OAuth and ad tracking per agency account.
