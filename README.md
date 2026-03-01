# GhostPay (Private Tap-to-Pay on Monad Testnet)

GhostPay is a neobank-style POS + payer flow demo with Unlink private transfers on Monad Testnet.

## What this builds

- Merchant creates a payment request with amount/token/memo/expiry and optional single-use behavior.
- Merchant displays a shareable QR + link.
- Payer opens the link or scans QR, creates a private wallet if needed, and pays privately.
- Merchant sees private payment arrival in-app (no need to inspect chain traces).
- Optional public withdraw from private wallet to EOA for a “cash-out” moment.

## Current token behavior

- 5 payment options are available:
  - `MON`, `USDC`, `USDCV2`, `USDT`, `ULNK`
- Default payment token is `USDC`.
- Settlement token can be selected independently (manual exchange note only; auto-swap is not enabled in this MVP).

## Environment variables

Create `.env` from `.env.example`.

### Frontend

- `VITE_GHOSTPAY_REQUEST_BACKEND`
  - Required for request creation and live cross-device sync.
  - In production on Vercel, if omitted it defaults to `/api/ghostpay`.
  - In local dev, if omitted it defaults to `http://localhost:4123`.
- `VITE_GHOSTPAY_REQUIRE_REQUEST_SIGNATURE`
  - Set to `true` to require browser-wallet signed payment requests.
  - Set to `false` (default) to allow unsigned requests in the demo flow.
- `VITE_GHOSTPAY_ADMIN_TOKEN` (optional)
  - Optional for frontend calls when you also protect backend POST endpoints. If set, frontend sends:
    - `Authorization: Bearer <token>` and
    - `X-Admin-Key: <token>` with POST requests to `/requests`.
  - For public production use, treat this as a lightweight gate only; Vite vars are exposed to browsers.

### Backend (`backend/.env.example`)

- `GHOSTPAY_REQUEST_DB`
- `GHOSTPAY_ADMIN_TOKEN`
  - Optional shared secret. If set, POST endpoints require either:
    - `Authorization: Bearer <token>`
    - or `X-Admin-Key: <token>`
- `GHOSTPAY_REQUIRE_REQUEST_SIGNATURE`
  - Set to `true` to reject unsigned request creations.
- `GHOSTPAY_CLAIM_LOCK_MS`
  - Lock window for in-flight payer claims (milliseconds).
- `GHOSTPAY_CLAIM_LOCK_TTL_MS`
  - Maximum claim age before it is released automatically.
- `GHOSTPAY_REQUEST_TTL_MS`
  - Maximum allowed request validity window (createdAt→expiresAt).
- `GHOSTPAY_REQUEST_STORE_RETENTION_DAYS`
  - Retention window for completed/failed/expired requests, in days.
- `GHOSTPAY_CLEANUP_INTERVAL_MS`
  - Frequency of automatic prune/normalization cycles.
- `GHOSTPAY_MAX_REQUESTS_PER_MERCHANT`
  - Per-merchant request history cap in store.
- `GHOSTPAY_MAX_BODY_BYTES`
- `GHOSTPAY_POST_RATE_LIMIT_WINDOW_MS`
- `GHOSTPAY_POST_RATE_LIMIT_MAX`
- `GHOSTPAY_GET_RATE_LIMIT_WINDOW_MS`
- `GHOSTPAY_GET_RATE_LIMIT_MAX`

### Vercel proxy function env vars

- `GHOSTPAY_BACKEND_URL`
  - Base URL for your private backend that `api/ghostpay/requests` should forward to (for example `https://your-backend-host.example`).
- `GHOSTPAY_ADMIN_TOKEN`
  - Optional; if set, proxy injects token into forwarded requests.
- `GHOSTPAY_REQUEST_TIMEOUT_MS`
  - Optional timeout for proxy requests in ms (default `10000`).

## Quick start (local)

```bash
npm install
npm run dev
```

If you also run the backend in the same machine:

```bash
npm run backend
```

Then set:

```env
VITE_GHOSTPAY_REQUEST_BACKEND=http://localhost:4123
```

## Publish for public test (recommended flow)

1. Deploy the backend on a public HTTPS host (or any reachable host) and keep it running:
   - `PORT=4123`
   - `npm run backend`
2. Set your frontend env for that host:

```env
VITE_GHOSTPAY_REQUEST_BACKEND=https://your-backend-host.example
```
3. (Optional) configure Vercel serverless proxy so browser never holds the admin token:

```
GHOSTPAY_BACKEND_URL=https://your-backend-host.example
GHOSTPAY_ADMIN_TOKEN=your-shared-token
```

4. Deploy frontend to any static host (Vite output)
   - `npm run build`
   - upload `dist/`

If you use Vercel:

- Set `VITE_GHOSTPAY_REQUEST_BACKEND` (optional, defaults to `/api/ghostpay` in production)
- Set `GHOSTPAY_BACKEND_URL` and `GHOSTPAY_ADMIN_TOKEN` as backend function environment variables
- Deploy the repo branch and use the generated public URL

### Current deployment status (March 1, 2026)

- GitHub repository: https://github.com/Halldon/ghostpay-tap2pay
- Vercel project: `ghostpay-tap2pay`
- Vercel production URL: https://ghostpay-tap2pay.vercel.app
- Requested domain alias: `https://tye.ai` (DNS still requires final propagation/verification for HTTPS)

## Domain wiring for `tye.ai`

Vercel side is configured and alias is reserved to this project. GoDaddy needs these DNS changes:

- A record: `@ -> 76.76.21.21`
- CNAME (optional / for `www`): `www -> cname.vercel-dns-016.com`

If you can point nameservers to Vercel instead, you can use Vercel-managed DNS directly.

## Core demo script

1. Merchant: open Merchant mode, set amount + memo, click **Create Request**, show QR fullscreen.
2. Payer: open payer link/QR, review request summary, then click **Pay Privately**.
3. Merchant: watch **Payments Received** move to **Succeeded** when proof confirms.
4. Merchant: optional public withdraw to EOA and point to explorer tx.

## Required external inputs from you

For a public launch, you only need to provide:

1. A stable backend URL for `VITE_GHOSTPAY_REQUEST_BACKEND` (e.g., `https://api.ghostpay.example`).
2. A public frontend host (Vercel/Netlify/etc.) for the built frontend.

No Unlink private-network API keys are required in this architecture because the SDK uses the hosted Monad Testnet integration through:

```tsx
<UnlinkProvider chain="monad-testnet" autoSync={true} />
```

## Privacy notes

- Deposits and withdrawals are public onchain (visible in the explorer).
- Unlink transfers are private: explorer cannot reveal payer/recipient or transfer amounts.

## Backend endpoints

- `GET /requests?merchant=<recipient_address>` => `{ requests: [...] }`
- `POST /requests` => upsert request records for demo relay
- `GET /health` => `{ ok: true }`

Data is stored at `backend/requests-store.json` by default.

## Notes

- Keep request payloads URL-safe base64 encoded.
- Request includes integer/base-unit amount and expiry metadata.
- Expired / single-use requests are blocked on payer side.
