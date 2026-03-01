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
  - Optional for local/same-device demos.
  - Required for public cross-device live updates (merchant/payer on different devices).

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

3. Deploy frontend to any static host (Vite output)
   - `npm run build`
   - upload `dist/`

If you use Vercel:

- Set `VITE_GHOSTPAY_REQUEST_BACKEND` in project environment variables
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
