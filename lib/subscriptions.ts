export const FILE_TRANSFERS_PRO_NAME = "FileTransfers Pro";

// Keep `premium` as the primary identifier so existing webhook/backend behavior
// continues to work, but accept common aliases during rollout.
export const PREMIUM_ENTITLEMENT_ID = "premium";
export const PREMIUM_ENTITLEMENT_ALIASES = [
  PREMIUM_ENTITLEMENT_ID,
  "filetransfers_pro",
  FILE_TRANSFERS_PRO_NAME,
] as const;

export const PREMIUM_PRODUCT_IDS = {
  monthly: "monthly",
  yearly: "yearly",
} as const;

export type PremiumPlanKey = keyof typeof PREMIUM_PRODUCT_IDS;
