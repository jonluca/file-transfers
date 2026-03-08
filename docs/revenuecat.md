# RevenueCat Setup

Official docs:

- [React Native installation](https://www.revenuecat.com/docs/getting-started/installation/reactnative#installation)
- [Paywalls](https://www.revenuecat.com/docs/tools/paywalls)
- [Customer Center](https://www.revenuecat.com/docs/tools/customer-center)

## 1. Install with npm

```bash
npm install --save react-native-purchases react-native-purchases-ui
```

This repo uses Expo development builds, so rebuild native projects after changing native dependencies:

```bash
pnpm mobile:prepare
```

Then run a fresh development build:

```bash
pnpm ios
# or
pnpm android
```

RevenueCat purchases and paywalls do not run for real inside Expo Go.

## 2. Configure SDK keys

Set the RevenueCat public SDK keys in your environment:

```bash
EXPO_PUBLIC_REVENUECAT_IOS_API_KEY=appl_LejwKJcXkrNdohYjxcRSXYJvcgo
EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY=goog_your_android_sdk_key
```

Notes:

- The provided `appl_...` key is iOS-only.
- Android needs its own `goog_...` RevenueCat SDK key.
- The app reads these keys in [`lib/purchases.ts`](/Users/jonlucadecaro/Documents/Other/file-transfers/lib/purchases.ts).

## 3. RevenueCat dashboard setup

Create the following in RevenueCat:

1. Products
   - `monthly`
   - `yearly`
2. Entitlement
   - Primary app identifier: `premium`
   - User-facing name in the app: `FileTransfers Pro`
3. Current offering
   - Attach the `monthly` product to the monthly package
   - Attach the `yearly` product to the annual package
4. Paywall
   - Build a paywall against the current offering
5. Customer Center
   - Enable it in the RevenueCat dashboard and add any restore/support/custom URL actions you want

The app is resilient to common entitlement aliases during setup (`premium`, `filetransfers_pro`, `FileTransfers Pro`), but `premium` is still the cleanest identifier for this codebase because the backend already understands it.

## 4. App architecture in this repo

- [`providers/revenuecat-provider.tsx`](/Users/jonlucadecaro/Documents/Other/file-transfers/providers/revenuecat-provider.tsx)
  - Configures RevenueCat once
  - Logs in/out with the Better Auth user ID
  - Listens for `CustomerInfo` updates
  - Syncs premium state back to the backend
  - Presents the paywall and Customer Center
- [`hooks/use-premium-access.ts`](/Users/jonlucadecaro/Documents/Other/file-transfers/hooks/use-premium-access.ts)
  - Merges server entitlements with local RevenueCat customer info
- [`app/(app)/(tabs)/settings.tsx`](</Users/jonlucadecaro/Documents/Other/file-transfers/app/(app)/(tabs)/settings.tsx>)
  - Shows monthly/yearly plan info
  - Opens the RevenueCat paywall
  - Restores purchases
  - Opens Customer Center
- [`app/(app)/(tabs)/index.tsx`](</Users/jonlucadecaro/Documents/Other/file-transfers/app/(app)/(tabs)/index.tsx>)
  - Uses the merged premium state so local premium unlocks transfer speed immediately
- [`server/app.ts`](/Users/jonlucadecaro/Documents/Other/file-transfers/server/app.ts)
  - Accepts RevenueCat webhook entitlement updates

## 5. Implementation examples

### Present the paywall

```tsx
const { presentPaywall } = useRevenueCat();

async function handleUpgrade() {
  const result = await presentPaywall();

  if (result === REVENUECAT_PAYWALL_RESULT.PURCHASED) {
    // premium is now active on-device
  }
}
```

### Restore purchases

```tsx
const { restorePurchases } = useRevenueCat();

async function handleRestore() {
  const customerInfo = await restorePurchases();
  const entitlement = mapCustomerInfoToEntitlement(customerInfo, true);

  if (entitlement.isPremium) {
    // user has FileTransfers Pro access
  }
}
```

### Check the entitlement

```tsx
const premiumAccess = usePremiumAccess();

if (premiumAccess.isPremium) {
  // unlock FileTransfers Pro features
}
```

### Open Customer Center

```tsx
const { presentCustomerCenter } = useRevenueCat();

async function handleManageSubscription() {
  await presentCustomerCenter();
}
```

## 6. Best practices used here

- Configure RevenueCat once, then use `logIn` / `logOut` for app identity changes.
- Listen for `CustomerInfo` updates instead of only checking state after button presses.
- Treat `CustomerInfo.entitlements.active` as the source of truth for premium access.
- Allow anonymous purchases locally, but encourage sign-in for hosted links and cross-device restore.
- Keep RevenueCat UI as the primary purchase surface, not a hand-built purchase sheet.
- Refresh customer info when the app becomes active.
- Handle cancel, pending, offline, and configuration errors with explicit user-facing messages.

## 7. Validation checklist

1. Launch a fresh development build, not Expo Go.
2. Open Settings.
3. Confirm the current offering shows monthly and yearly plans.
4. Open the paywall and complete a sandbox purchase.
5. Verify transfer speed unlocks immediately.
6. Restore purchases from Settings.
7. Open Customer Center from Settings.
8. Confirm the RevenueCat webhook updates the backend membership row after a purchase or renewal.
