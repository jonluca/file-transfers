import { useEntitlements } from "@/hooks/queries";
import { useRevenueCat } from "@/providers/revenuecat-provider";
import { canUseLocalPremiumOverride } from "@/lib/build-environment";
import { useDevPremiumOverrideEnabled } from "@/store";

export function usePremiumAccess() {
  const entitlementsQuery = useEntitlements();
  const revenueCat = useRevenueCat();
  const devPremiumOverrideEnabled = useDevPremiumOverrideEnabled();

  const serverEntitlement = entitlementsQuery.data;
  const localEntitlement = revenueCat.entitlement;
  const isLocalPremiumOverrideEnabled = canUseLocalPremiumOverride() && devPremiumOverrideEnabled;
  const isPremium = Boolean(
    isLocalPremiumOverrideEnabled || serverEntitlement?.isPremium || localEntitlement.isPremium,
  );

  return {
    entitlement: {
      isAuthenticated: Boolean(serverEntitlement?.isAuthenticated || localEntitlement.isAuthenticated),
      isPremium,
      source: isLocalPremiumOverrideEnabled
        ? "preview"
        : serverEntitlement?.isPremium
          ? serverEntitlement.source
          : localEntitlement.source,
      managementUrl: serverEntitlement?.managementUrl ?? localEntitlement.managementUrl,
      expiresAt: serverEntitlement?.expiresAt ?? localEntitlement.expiresAt,
    },
    isDevPremiumOverrideEnabled: isLocalPremiumOverrideEnabled,
    isLocalPremiumOverrideEnabled,
    isLoading: entitlementsQuery.isLoading || revenueCat.isLoadingCustomerInfo,
    isPremium,
    query: entitlementsQuery,
  };
}
