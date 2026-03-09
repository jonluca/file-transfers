# File Share

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
pnpm macos:device # macOS sender/receiver emulator for transfer debugging
pnpm android      # Run Android build
pnpm server:dev   # Hono dev server
pnpm build        # Build backend bundle
pnpm start        # Start backend bundle
pnpm db:generate  # Generate a new Drizzle migration
pnpm typecheck
pnpm lint
pnpm format:check
```

`pnpm mobile:prepare` now reapplies the iOS In-App Purchase capability through the local Expo config plugin, so rerun it after deleting or regenerating `ios/`.

## Environment

See [`.env.example`](/Users/jonlucadecaro/Documents/Other/file-transfers/.env.example) for the current backend, auth, RevenueCat, and storage configuration surface.

## macOS Device Emulator

Use [`scripts/macos-transfer-device.ts`](/Users/jonlucadecaro/Documents/Other/file-transfers/scripts/macos-transfer-device.ts) to emulate a nearby device from macOS for transfer debugging. The script speaks the same fixed-port HTTP discovery/control/file protocol as the app, so it can act as either side of a transfer.

Start a long-running receiver service:

```bash
pnpm macos:device receive \
  --name "Mac Debug Receiver" \
  --output-dir ./tmp/macos-device-received \
  --state-file ./tmp/macos-device-receiver.json
```

That command:

- starts an HTTP receiver service on port `41000`
- advertises itself over Bonjour via `dns-sd` so the mobile sender can find it in nearby scan
- writes a JSON state file with the current `discoveryRecord`, `qrPayload`, progress, and last transfer result

List nearby receivers from macOS:

```bash
pnpm macos:device discover --json
```

Send files from macOS to an app receiver discovered over Bonjour:

```bash
pnpm macos:device send \
  --name "Mac Debug Sender" \
  --target-name "My iPhone" \
  --file ./fixtures/test-photo.jpg \
  --file ./fixtures/test-video.mov
```

Targeting options for `send`:

- `--target-name <device-or-service-name>` discovers a nearby receiver with `dns-sd`
- `--target-session-id <id>` discovers by receiver session ID
- `--target-file <path>` reads discovery JSON or a receiver state file written by `receive`
- `--target-qr <json>` accepts the raw discovery payload directly

Generate a launchd plist for a background receiver service:

```bash
pnpm macos:device print-launch-agent \
  --name "Mac Debug Receiver" \
  --output-dir ./tmp/macos-device-received \
  --state-file ./tmp/macos-device-receiver.json \
  > ~/Library/LaunchAgents/com.filetransfers.macos-device.plist
```

Then load it with:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.filetransfers.macos-device.plist
launchctl kickstart -k "gui/$(id -u)/com.filetransfers.macos-device"
```

## Notes

- Local transfer discovery uses Bonjour/mDNS and fixed-port HTTP on port `41000`, so test on real devices on the same WiFi network.
- Hosted files default to local server storage in development and switch to Cloudflare R2 presigned uploads/downloads when the R2 environment variables are set.
- Production hosted-link pages should use `https://storage.filetransfersapp.com` as `HOSTED_FILES_BASE_URL`.
- RevenueCat purchase flows stay disabled until the public iOS and Android API keys are configured.
- RevenueCat setup details for this repo live in [`docs/revenuecat.md`](/Users/jonlucadecaro/Documents/Other/file-transfers/docs/revenuecat.md).
