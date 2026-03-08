import { useEntitlements } from "@/hooks/queries";
import { useRevenueCat } from "@/providers/revenuecat-provider";

export function usePremiumAccess() {
  const entitlementsQuery = useEntitlements();
  const revenueCat = useRevenueCat();

  const serverEntitlement = entitlementsQuery.data;
  const localEntitlement = revenueCat.entitlement;
  const isPremium = Boolean(serverEntitlement?.isPremium || localEntitlement.isPremium);

  return {
    entitlement: {
      isAuthenticated: Boolean(serverEntitlement?.isAuthenticated || localEntitlement.isAuthenticated),
      isPremium,
      source: serverEntitlement?.isPremium ? serverEntitlement.source : localEntitlement.source,
      managementUrl: serverEntitlement?.managementUrl ?? localEntitlement.managementUrl,
      expiresAt: serverEntitlement?.expiresAt ?? localEntitlement.expiresAt,
    },
    isLoading: entitlementsQuery.isLoading || revenueCat.isLoadingCustomerInfo,
    isPremium,
    query: entitlementsQuery,
  };
}
