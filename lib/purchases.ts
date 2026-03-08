import { Platform } from "react-native";
import Purchases, { LOG_LEVEL, type PurchasesPackage } from "react-native-purchases";
import type { EntitlementStatus } from "@/lib/file-transfer";
import { PREMIUM_ENTITLEMENT_ID } from "@/lib/file-transfer";

let configuredAppUserId: string | null = null;

function getRevenueCatApiKey() {
  if (Platform.OS === "ios") {
    return process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY?.trim() ?? null;
  }

  if (Platform.OS === "android") {
    return process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY?.trim() ?? null;
  }

  return null;
}

export function isRevenueCatConfigured() {
  return Boolean(getRevenueCatApiKey());
}

export function configurePurchases(appUserId: string | null) {
  const apiKey = getRevenueCatApiKey();

  if (!apiKey || configuredAppUserId === appUserId) {
    return;
  }

  Purchases.setLogLevel(LOG_LEVEL.WARN);
  Purchases.configure({
    apiKey,
    appUserID: appUserId ?? undefined,
  });
  configuredAppUserId = appUserId;
}

export async function getOfferings() {
  if (!isRevenueCatConfigured()) {
    return null;
  }

  return Purchases.getOfferings();
}

export async function purchasePackage(selectedPackage: PurchasesPackage) {
  if (!isRevenueCatConfigured()) {
    throw new Error("RevenueCat is not configured for this build.");
  }

  return Purchases.purchasePackage(selectedPackage);
}

export async function restorePurchases() {
  if (!isRevenueCatConfigured()) {
    throw new Error("RevenueCat is not configured for this build.");
  }

  return Purchases.restorePurchases();
}

export async function loginPurchases(appUserId: string) {
  if (!isRevenueCatConfigured()) {
    return null;
  }

  return Purchases.logIn(appUserId);
}

export async function logoutPurchases() {
  if (!isRevenueCatConfigured()) {
    return;
  }

  await Purchases.logOut();
  configuredAppUserId = null;
}

export async function getCustomerInfo() {
  if (!isRevenueCatConfigured()) {
    return null;
  }

  return Purchases.getCustomerInfo();
}

export function mapCustomerInfoToEntitlement(
  customerInfo: Awaited<ReturnType<typeof getCustomerInfo>>,
): EntitlementStatus {
  const activeEntitlement = customerInfo?.entitlements.active[PREMIUM_ENTITLEMENT_ID];

  return {
    isAuthenticated: true,
    isPremium: Boolean(activeEntitlement),
    source: "client_sync",
    managementUrl: customerInfo?.managementURL ?? null,
    expiresAt: activeEntitlement?.expirationDate ?? null,
  };
}
