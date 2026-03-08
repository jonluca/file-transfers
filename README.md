# File Transfers

Anonymous-first Expo app for device-to-device file transfers. Free transfers stay local on the same WiFi network, while premium adds faster transfer speeds, hosted browser-download links, and cross-device purchase restore after sign-in.

## Prerequisites

- Node.js 24+
- pnpm 10
- Xcode or Android Studio for development builds
- PostgreSQL for the backend
- A custom development build for local network discovery, camera QR scanning, and in-app purchases

## Setup

```bash
pnpm install
cp .env.example .env
pnpm auth:generate
pnpm server:dev
```

In another terminal:

```bash
pnpm ios
# or
pnpm android
```

## Scripts

```bash
pnpm dev          # Expo dev client
pnpm ios          # Run an iOS development build
pnpm mobile:prepare # Regenerate native projects after config/plugin changes
pnpm mobile:dev   # Run an iOS dev build on a connected device
pnpm android      # Run Android build
pnpm server:dev   # Hono dev server
pnpm build        # Build backend bundle
pnpm start        # Start backend bundle
pnpm db:generate  # Generate a new Drizzle migration
pnpm typecheck
pnpm lint
pnpm format:check
```

## Environment

See [`.env.example`](/Users/jonlucadecaro/Documents/Other/file-transfers/.env.example) for the current backend, auth, RevenueCat, and storage configuration surface.

## Notes

- Local transfer discovery uses Bonjour/mDNS and TLS sockets, so test on real devices on the same WiFi network.
- Hosted files default to local server storage in development and switch to Cloudflare R2 presigned uploads/downloads when the R2 environment variables are set.
- Production hosted-link pages should use `https://storage.filetransfersapp.com` as `HOSTED_FILES_BASE_URL`.
- RevenueCat purchase flows stay disabled until the public iOS and Android API keys are configured.
