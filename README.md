# Mobile Boilerplate

A native-first Expo starter modeled on Palate's reusable architecture. It includes Expo Router with native tabs, Hono + tRPC, Better Auth with Apple sign-in, Drizzle/Postgres, Zustand persistence, TanStack Query, Uniwind, and an `@expo/ui` showcase screen.

## Prerequisites

- Node.js 24+
- pnpm 10
- Xcode or Android Studio for development builds
- PostgreSQL for the backend

## Setup

```bash
pnpm install
cp .env.example .env
pnpm auth:generate
pnpm db:generate
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
pnpm ios          # Run iOS build
pnpm mobile:prepare # Regenerate native projects with a clean prebuild
pnpm mobile:dev   # Run iOS dev build on a connected device
pnpm android      # Run Android build
pnpm server:dev   # Hono dev server
pnpm build        # Build backend bundle
pnpm start        # Start backend bundle
pnpm typecheck
pnpm lint
pnpm format:check
```

## Environment

See [`.env.example`](/Users/jonlucadecaro/Documents/Other/mobile-boilerplate/.env.example) for required values. Apple sign-in remains disabled until the Apple provider variables are configured.
