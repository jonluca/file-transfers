import * as ExpoLinking from "expo-linking";
import React, { createContext, useContext, useEffect, useEffectEvent, useState } from "react";
import { AppState } from "react-native";
import { PAYWALL_RESULT } from "react-native-purchases-ui";
import type { EntitlementStatus } from "@/lib/file-transfer";
import { useSyncPurchase } from "@/hooks/queries";
import { useSession } from "@/lib/auth-client";
import {
  addCustomerInfoUpdateListener,
  configurePurchases,
  getCustomerInfo,
  getOfferings,
  getPaywallResultMessage,
  getPremiumPackages,
  getPurchaseErrorMessage,
  loginPurchases,
  logoutPurchases,
  mapCustomerInfoToEntitlement,
  isPurchaseCancelledError,
  isRevenueCatConfigured,
  presentCustomerCenter as openRevenueCatCustomerCenter,
  presentPaywall as openRevenueCatPaywall,
  purchasePackage as purchaseRevenueCatPackage,
  restorePurchases as restoreRevenueCatPurchases,
  removeCustomerInfoUpdateListener,
  type RevenueCatCustomerInfo,
  type RevenueCatOfferings,
  type RevenueCatPackage,
} from "@/lib/purchases";

const EMPTY_ENTITLEMENT: EntitlementStatus = {
  isAuthenticated: false,
  isPremium: false,
  source: "anonymous",
  managementUrl: null,
  expiresAt: null,
};

interface RevenueCatContextValue {
  isConfigured: boolean;
  entitlement: EntitlementStatus;
  customerInfo: RevenueCatCustomerInfo | null;
  offerings: RevenueCatOfferings | null;
  plans: ReturnType<typeof getPremiumPackages>;
  isLoadingCustomerInfo: boolean;
  isLoadingOfferings: boolean;
  lastError: string | null;
  refreshCustomerInfo: (options?: { silent?: boolean }) => Promise<RevenueCatCustomerInfo | null>;
  refreshOfferings: (options?: { silent?: boolean }) => Promise<RevenueCatOfferings | null>;
  presentPaywall: () => Promise<PAYWALL_RESULT | null>;
  purchasePackage: (selectedPackage: RevenueCatPackage) => Promise<RevenueCatCustomerInfo | null>;
  restorePurchases: () => Promise<RevenueCatCustomerInfo | null>;
  presentCustomerCenter: () => Promise<string | null>;
  clearError: () => void;
}

const RevenueCatContext = createContext<RevenueCatContextValue | null>(null);

export function RevenueCatProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const syncPurchaseMutation = useSyncPurchase();
  const sessionUserId = session?.user?.id ?? null;
  const isConfigured = isRevenueCatConfigured();
  const [customerInfo, setCustomerInfo] = useState<RevenueCatCustomerInfo | null>(null);
  const [offerings, setOfferings] = useState<RevenueCatOfferings | null>(null);
  const [isLoadingCustomerInfo, setIsLoadingCustomerInfo] = useState(isConfigured);
  const [isLoadingOfferings, setIsLoadingOfferings] = useState(isConfigured);
  const [lastError, setLastError] = useState<string | null>(null);

  const syncCustomerInfoToBackend = useEffectEvent(async (nextCustomerInfo: RevenueCatCustomerInfo | null) => {
    if (!sessionUserId || !nextCustomerInfo) {
      return;
    }

    try {
      await syncPurchaseMutation.mutateAsync({
        ...mapCustomerInfoToEntitlement(nextCustomerInfo, true),
        appUserId: sessionUserId,
      });
    } catch (error) {
      console.error("Unable to sync RevenueCat entitlement to the backend", error);
    }
  });

  const applyCustomerInfo = useEffectEvent(async (nextCustomerInfo: RevenueCatCustomerInfo | null) => {
    setCustomerInfo(nextCustomerInfo);
    await syncCustomerInfoToBackend(nextCustomerInfo);
  });

  async function refreshCustomerInfo(options?: { silent?: boolean }) {
    if (!isConfigured) {
      return null;
    }

    if (!options?.silent) {
      setIsLoadingCustomerInfo(true);
    }

    try {
      setLastError(null);
      const nextCustomerInfo = await getCustomerInfo();
      await applyCustomerInfo(nextCustomerInfo);
      return nextCustomerInfo;
    } catch (error) {
      console.error("Unable to refresh RevenueCat customer info", error);
      setLastError(getPurchaseErrorMessage(error));
      return null;
    } finally {
      if (!options?.silent) {
        setIsLoadingCustomerInfo(false);
      }
    }
  }

  async function refreshOfferings(options?: { silent?: boolean }) {
    if (!isConfigured) {
      return null;
    }

    if (!options?.silent) {
      setIsLoadingOfferings(true);
    }

    try {
      setLastError(null);
      const nextOfferings = await getOfferings();
      setOfferings(nextOfferings);
      return nextOfferings;
    } catch (error) {
      console.error("Unable to load RevenueCat offerings", error);
      setLastError(getPurchaseErrorMessage(error));
      return null;
    } finally {
      if (!options?.silent) {
        setIsLoadingOfferings(false);
      }
    }
  }

  useEffect(() => {
    if (!isConfigured) {
      setCustomerInfo(null);
      setOfferings(null);
      setIsLoadingCustomerInfo(false);
      setIsLoadingOfferings(false);
      return;
    }

    configurePurchases(null);
  }, [isConfigured]);

  useEffect(() => {
    if (!isConfigured) {
      return;
    }

    let cancelled = false;

    async function syncIdentity() {
      setIsLoadingCustomerInfo(true);
      setIsLoadingOfferings(true);

      try {
        setLastError(null);

        const nextCustomerInfo = sessionUserId
          ? ((await loginPurchases(sessionUserId))?.customerInfo ?? null)
          : await logoutPurchases();

        if (cancelled) {
          return;
        }

        await applyCustomerInfo(nextCustomerInfo);

        const nextOfferings = await getOfferings();
        if (cancelled) {
          return;
        }

        setOfferings(nextOfferings);
      } catch (error) {
        if (cancelled) {
          return;
        }

        console.error("Unable to initialize RevenueCat session", error);
        setLastError(getPurchaseErrorMessage(error));
      } finally {
        if (!cancelled) {
          setIsLoadingCustomerInfo(false);
          setIsLoadingOfferings(false);
        }
      }
    }

    void syncIdentity();

    return () => {
      cancelled = true;
    };
  }, [isConfigured, sessionUserId]);

  const handleCustomerInfoUpdate = useEffectEvent(async (nextCustomerInfo: RevenueCatCustomerInfo) => {
    setLastError(null);
    await applyCustomerInfo(nextCustomerInfo);
  });

  useEffect(() => {
    if (!isConfigured) {
      return;
    }

    const listener = (nextCustomerInfo: RevenueCatCustomerInfo) => {
      void handleCustomerInfoUpdate(nextCustomerInfo);
    };

    addCustomerInfoUpdateListener(listener);

    return () => {
      removeCustomerInfoUpdateListener(listener);
    };
  }, [isConfigured, sessionUserId]);

  const handleAppStateChange = useEffectEvent((nextAppState: string) => {
    if (nextAppState !== "active") {
      return;
    }

    void refreshCustomerInfo({ silent: true });
    void refreshOfferings({ silent: true });
  });

  useEffect(() => {
    if (!isConfigured) {
      return;
    }

    const subscription = AppState.addEventListener("change", handleAppStateChange);
    return () => subscription.remove();
  }, [isConfigured]);

  async function presentPaywall() {
    if (!isConfigured) {
      setLastError("RevenueCat is not configured for this build.");
      return null;
    }

    if (customerInfo && mapCustomerInfoToEntitlement(customerInfo, Boolean(sessionUserId)).isPremium) {
      return PAYWALL_RESULT.NOT_PRESENTED;
    }

    setIsLoadingCustomerInfo(true);

    try {
      setLastError(null);
      const paywallResult = await openRevenueCatPaywall(offerings?.current);

      if (
        paywallResult === PAYWALL_RESULT.PURCHASED ||
        paywallResult === PAYWALL_RESULT.RESTORED ||
        paywallResult === PAYWALL_RESULT.NOT_PRESENTED
      ) {
        await refreshCustomerInfo({ silent: true });
      }

      if (paywallResult === PAYWALL_RESULT.ERROR) {
        setLastError(getPaywallResultMessage(paywallResult));
      }

      return paywallResult;
    } catch (error) {
      console.error("Unable to present the RevenueCat paywall", error);
      setLastError(getPurchaseErrorMessage(error));
      return PAYWALL_RESULT.ERROR;
    } finally {
      setIsLoadingCustomerInfo(false);
    }
  }

  async function purchasePackage(selectedPackage: RevenueCatPackage) {
    if (!isConfigured) {
      setLastError("RevenueCat is not configured for this build.");
      return null;
    }

    setIsLoadingCustomerInfo(true);

    try {
      setLastError(null);
      const purchaseResult = await purchaseRevenueCatPackage(selectedPackage);
      await applyCustomerInfo(purchaseResult.customerInfo);
      return purchaseResult.customerInfo;
    } catch (error) {
      if (!isPurchaseCancelledError(error)) {
        console.error("Unable to complete the RevenueCat purchase", error);
      }

      setLastError(isPurchaseCancelledError(error) ? null : getPurchaseErrorMessage(error));
      return null;
    } finally {
      setIsLoadingCustomerInfo(false);
    }
  }

  async function restorePurchases() {
    if (!isConfigured) {
      setLastError("RevenueCat is not configured for this build.");
      return null;
    }

    setIsLoadingCustomerInfo(true);

    try {
      setLastError(null);
      const nextCustomerInfo = await restoreRevenueCatPurchases();
      await applyCustomerInfo(nextCustomerInfo);
      return nextCustomerInfo;
    } catch (error) {
      console.error("Unable to restore RevenueCat purchases", error);
      setLastError(getPurchaseErrorMessage(error));
      return null;
    } finally {
      setIsLoadingCustomerInfo(false);
    }
  }

  async function presentCustomerCenter() {
    if (!isConfigured) {
      const message = "RevenueCat is not configured for this build.";
      setLastError(message);
      return message;
    }

    try {
      setLastError(null);
      await openRevenueCatCustomerCenter({
        callbacks: {
          onManagementOptionSelected: (event) => {
            if (event.option === "custom_url" && event.url) {
              void ExpoLinking.openURL(event.url);
            }
          },
          onRestoreCompleted: ({ customerInfo: nextCustomerInfo }) => {
            void applyCustomerInfo(nextCustomerInfo);
          },
          onRestoreFailed: ({ error }) => {
            setLastError(getPurchaseErrorMessage(error));
          },
        },
      });
      return null;
    } catch (error) {
      console.error("Unable to present RevenueCat Customer Center", error);
      const message = getPurchaseErrorMessage(error);
      setLastError(message);
      return message;
    }
  }

  const entitlement = customerInfo
    ? mapCustomerInfoToEntitlement(customerInfo, Boolean(sessionUserId))
    : EMPTY_ENTITLEMENT;

  return (
    <RevenueCatContext.Provider
      value={{
        isConfigured,
        entitlement,
        customerInfo,
        offerings,
        plans: getPremiumPackages(offerings),
        isLoadingCustomerInfo,
        isLoadingOfferings,
        lastError,
        refreshCustomerInfo,
        refreshOfferings,
        presentPaywall,
        purchasePackage,
        restorePurchases,
        presentCustomerCenter,
        clearError: () => setLastError(null),
      }}
    >
      {children}
    </RevenueCatContext.Provider>
  );
}

export function useRevenueCat() {
  const context = useContext(RevenueCatContext);

  if (!context) {
    throw new Error("useRevenueCat must be used within a RevenueCatProvider.");
  }

  return context;
}
