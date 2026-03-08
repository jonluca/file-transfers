import { Platform } from "react-native";
import Purchases, {
  LOG_LEVEL,
  PACKAGE_TYPE,
  type CustomerInfo,
  type CustomerInfoUpdateListener,
  type LogInResult,
  type PurchasesError,
  type PurchasesOffering,
  type PurchasesOfferings,
  type PurchasesPackage,
} from "react-native-purchases";
import RevenueCatUI, { PAYWALL_RESULT } from "react-native-purchases-ui";
import type { PresentCustomerCenterParams } from "react-native-purchases-ui";
import type { EntitlementStatus } from "@/lib/file-transfer";
import {
  PREMIUM_ENTITLEMENT_ALIASES,
  PREMIUM_ENTITLEMENT_ID,
  PREMIUM_PRODUCT_IDS,
  type PremiumPlanKey,
} from "@/lib/subscriptions";

let hasConfiguredPurchases = false;
let activeAppUserId: string | null = null;

function getRevenueCatApiKey() {
  if (Platform.OS === "ios") {
    return process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY?.trim() ?? null;
  }

  if (Platform.OS === "android") {
    return process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY?.trim() ?? null;
  }

  return null;
}

function ensurePurchasesConfigured() {
  if (!isRevenueCatConfigured()) {
    return false;
  }

  configurePurchases(null);
  return true;
}

export function isRevenueCatConfigured() {
  return Boolean(getRevenueCatApiKey());
}

export function configurePurchases(appUserId: string | null) {
  const apiKey = getRevenueCatApiKey();

  if (!apiKey || hasConfiguredPurchases) {
    return false;
  }

  Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.DEBUG : LOG_LEVEL.WARN);
  Purchases.configure({
    apiKey,
    appUserID: appUserId ?? undefined,
    diagnosticsEnabled: __DEV__,
    entitlementVerificationMode: Purchases.ENTITLEMENT_VERIFICATION_MODE.INFORMATIONAL,
  });

  hasConfiguredPurchases = true;
  activeAppUserId = appUserId;

  return true;
}

export function addCustomerInfoUpdateListener(listener: CustomerInfoUpdateListener) {
  if (!ensurePurchasesConfigured()) {
    return false;
  }

  Purchases.addCustomerInfoUpdateListener(listener);
  return true;
}

export function removeCustomerInfoUpdateListener(listener: CustomerInfoUpdateListener) {
  return Purchases.removeCustomerInfoUpdateListener(listener);
}

export async function getOfferings() {
  if (!ensurePurchasesConfigured()) {
    return null;
  }

  return Purchases.getOfferings();
}

export async function purchasePackage(selectedPackage: PurchasesPackage) {
  if (!ensurePurchasesConfigured()) {
    throw new Error("RevenueCat is not configured for this build.");
  }

  return Purchases.purchasePackage(selectedPackage);
}

export async function restorePurchases() {
  if (!ensurePurchasesConfigured()) {
    throw new Error("RevenueCat is not configured for this build.");
  }

  return Purchases.restorePurchases();
}

export async function loginPurchases(appUserId: string) {
  if (!ensurePurchasesConfigured()) {
    return null;
  }

  const result = await Purchases.logIn(appUserId);
  activeAppUserId = appUserId;
  return result;
}

export async function logoutPurchases() {
  if (!ensurePurchasesConfigured()) {
    return null;
  }

  if (!activeAppUserId) {
    return getCustomerInfo();
  }

  try {
    const customerInfo = await Purchases.logOut();
    activeAppUserId = null;
    return customerInfo;
  } catch (error) {
    if (isAnonymousLogOutError(error)) {
      activeAppUserId = null;
      return getCustomerInfo();
    }

    throw error;
  }
}

export async function getCustomerInfo() {
  if (!ensurePurchasesConfigured()) {
    return null;
  }

  return Purchases.getCustomerInfo();
}

export async function presentPaywall(offering?: PurchasesOffering | null) {
  if (!ensurePurchasesConfigured()) {
    throw new Error("RevenueCat is not configured for this build.");
  }

  return RevenueCatUI.presentPaywall({
    displayCloseButton: true,
    offering: offering ?? undefined,
  });
}

export async function presentCustomerCenter(params?: PresentCustomerCenterParams) {
  if (!ensurePurchasesConfigured()) {
    throw new Error("RevenueCat is not configured for this build.");
  }

  return RevenueCatUI.presentCustomerCenter(params);
}

export function getPaywallResultMessage(result: PAYWALL_RESULT) {
  switch (result) {
    case PAYWALL_RESULT.NOT_PRESENTED:
      return "FileTransfers Pro is already active.";
    case PAYWALL_RESULT.PURCHASED:
      return "FileTransfers Pro is active on this device.";
    case PAYWALL_RESULT.RESTORED:
      return "Your purchases were restored.";
    case PAYWALL_RESULT.CANCELLED:
      return "Purchase cancelled.";
    case PAYWALL_RESULT.ERROR:
      return "The paywall could not complete the purchase.";
    default:
      return "Unable to complete the purchase flow.";
  }
}

export function getPurchaseErrorMessage(error: unknown) {
  if (isPurchaseCancelledError(error)) {
    return "Purchase cancelled.";
  }

  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code: string }).code);

    switch (code) {
      case Purchases.PURCHASES_ERROR_CODE.NETWORK_ERROR:
      case Purchases.PURCHASES_ERROR_CODE.OFFLINE_CONNECTION_ERROR:
        return "A network connection is required to contact RevenueCat.";
      case Purchases.PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR:
        return "The purchase is pending approval in the store.";
      case Purchases.PURCHASES_ERROR_CODE.PRODUCT_NOT_AVAILABLE_FOR_PURCHASE_ERROR:
        return "This subscription product is not available for this build yet.";
      case Purchases.PURCHASES_ERROR_CODE.CONFIGURATION_ERROR:
        return "RevenueCat is configured, but the products or offering are not ready yet.";
      default:
        break;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unable to complete the RevenueCat request.";
}

export function isPurchaseCancelledError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as PurchasesError).code) === Purchases.PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR
  );
}

function isAnonymousLogOutError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as PurchasesError).code) === Purchases.PURCHASES_ERROR_CODE.LOG_OUT_ANONYMOUS_USER_ERROR
  );
}

export function getActivePremiumEntitlement(customerInfo: CustomerInfo | null | undefined) {
  if (!customerInfo) {
    return null;
  }

  for (const entitlementId of PREMIUM_ENTITLEMENT_ALIASES) {
    const entitlement = customerInfo.entitlements.active[entitlementId];
    if (entitlement) {
      return entitlement;
    }
  }

  return null;
}

export function mapCustomerInfoToEntitlement(
  customerInfo: CustomerInfo | null,
  isAuthenticated = Boolean(activeAppUserId),
): EntitlementStatus {
  const activeEntitlement = getActivePremiumEntitlement(customerInfo);

  return {
    isAuthenticated,
    isPremium: Boolean(activeEntitlement),
    source: isAuthenticated ? "client_sync" : "anonymous",
    managementUrl: customerInfo?.managementURL ?? null,
    expiresAt: activeEntitlement?.expirationDate ?? null,
  };
}

function matchesPlan(selectedPackage: PurchasesPackage, planKey: PremiumPlanKey) {
  const productId = PREMIUM_PRODUCT_IDS[planKey];

  if (selectedPackage.product.identifier === productId || selectedPackage.identifier === productId) {
    return true;
  }

  if (planKey === "monthly") {
    return selectedPackage.packageType === PACKAGE_TYPE.MONTHLY;
  }

  return selectedPackage.packageType === PACKAGE_TYPE.ANNUAL;
}

export function getPremiumPackages(offerings: PurchasesOfferings | null | undefined) {
  const availablePackages = offerings?.current?.availablePackages ?? [];

  return {
    monthly: availablePackages.find((selectedPackage) => matchesPlan(selectedPackage, "monthly")) ?? null,
    yearly: availablePackages.find((selectedPackage) => matchesPlan(selectedPackage, "yearly")) ?? null,
    availablePackages,
  };
}

export type RevenueCatOfferings = PurchasesOfferings;
export type RevenueCatPackage = PurchasesPackage;
export type RevenueCatCustomerInfo = CustomerInfo;
export type RevenueCatLogInResult = LogInResult;
export const FILE_TRANSFERS_PRO_ENTITLEMENT_ID = PREMIUM_ENTITLEMENT_ID;
export const REVENUECAT_PAYWALL_RESULT = PAYWALL_RESULT;
