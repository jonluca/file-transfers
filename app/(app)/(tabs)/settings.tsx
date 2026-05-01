import Constants from "expo-constants";
import * as Linking from "expo-linking";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  InteractionManager,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { PACKAGE_TYPE, type PurchasesPackage } from "react-native-purchases";
import {
  Check,
  ChevronRight,
  Crown,
  HelpCircle,
  Info,
  Link,
  RefreshCw,
  Shield,
  SlidersHorizontal,
  Smartphone,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ContinueWithAppleButton, ContinueWithGoogleButton } from "@/components/auth";
import { useGoogleSignIn } from "@/hooks/use-google-sign-in";
import { usePremiumAccess } from "@/hooks/use-premium-access";
import { useAppleSignIn } from "@/hooks/use-apple-sign-in";
import { signOut, useSession } from "@/lib/auth-client";
import { canUseLocalPremiumOverride, isTestFlightBuild } from "@/lib/build-environment";
import { cn } from "@/lib/cn";
import { getTabScreenBottomPadding, getTabScreenTopInset } from "@/lib/design/tab-screen-insets";
import { designFonts, designTheme } from "@/lib/design/theme";
import {
  MAX_TRANSFER_CHUNK_SIZE_MEGABYTES,
  MIN_TRANSFER_CHUNK_SIZE_MEGABYTES,
  TRANSFER_CHUNK_SIZE_STEP_BYTES,
} from "@/lib/file-transfer/constants";
import { mapCustomerInfoToEntitlement } from "@/lib/purchases";
import { FILE_TRANSFERS_PRO_NAME } from "@/lib/subscriptions";
import { useRevenueCat } from "@/providers/revenuecat-provider";
import {
  useAppStore,
  useAutoAcceptKnownDevices,
  useDeviceName,
  useDevPremiumOverrideEnabled,
  useDirectTransferChunkBytes,
  useFreeTransferChunkBytes,
} from "@/store";

const fontStyles = {
  regular: { fontFamily: designFonts.regular },
  medium: { fontFamily: designFonts.medium },
  semibold: { fontFamily: designFonts.semibold },
} as const;

const TERMS_OF_USE_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";
const PRIVACY_POLICY_URL = "https://filetransfersapp.com/privacy.txt";
const SERVICE_TERMS_URL = "https://filetransfersapp.com/terms.txt";

function openLegalUrl(url: string) {
  void Linking.openURL(url);
}

function PrimaryButton({
  label,
  onPress,
  disabled = false,
  tone = "primary",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "primary" | "inverted";
}) {
  return (
    <Pressable
      className={cn(
        "min-h-12 items-center justify-center rounded-[14px] px-4",
        tone === "inverted" ? "bg-white" : "bg-[#2563eb]",
      )}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: disabled ? 0.5 : pressed ? 0.72 : 1 })}
    >
      <Text
        className={cn("text-base", tone === "inverted" ? "text-[#2563eb]" : "text-white")}
        style={fontStyles.medium}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SecondaryButton({
  label,
  onPress,
  tone = "default",
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
}) {
  return (
    <Pressable
      className={cn(
        "min-h-11 items-center justify-center rounded-[14px] border bg-white px-[14px]",
        tone === "danger" ? "border-[rgba(220,38,38,0.16)]" : "border-[#e5e7eb]",
      )}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: disabled ? 0.5 : pressed ? 0.72 : 1 })}
    >
      <Text
        className={cn("text-[15px]", tone === "danger" ? "text-[#dc2626]" : "text-[#030213]")}
        style={fontStyles.medium}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function InlineNotice({
  title,
  description,
  tone = "default",
}: {
  title: string;
  description: string;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <View
      className={cn(
        "gap-1 rounded-[14px] p-3",
        tone === "warning"
          ? "bg-[rgba(217,119,6,0.1)]"
          : tone === "danger"
            ? "bg-[rgba(220,38,38,0.08)]"
            : "bg-[#f9fafb]",
      )}
    >
      <Text className={"text-sm text-[#030213]"} style={fontStyles.medium}>
        {title}
      </Text>
      <Text className={"text-[13px] leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
        {description}
      </Text>
    </View>
  );
}

function SettingItem({
  icon,
  label,
  description,
  action,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  action?: React.ReactNode;
  onPress?: () => void;
}) {
  const content = (
    <View className={"min-h-[72px] flex-row items-center gap-3.5 border-b border-[#e5e7eb] bg-white px-4 py-[14px]"}>
      <View className={"h-9 w-9 items-center justify-center rounded-full bg-[#f3f4f6]"}>{icon}</View>
      <View className={"flex-1 gap-0.5"}>
        <Text className={"text-[15px] text-[#030213]"} style={fontStyles.medium}>
          {label}
        </Text>
        {description ? (
          <Text className={"text-[13px] leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
            {description}
          </Text>
        ) : null}
      </View>
      {action ?? (onPress ? <ChevronRight color={designTheme.mutedForeground} size={18} strokeWidth={2} /> : null)}
    </View>
  );

  if (!onPress) {
    return content;
  }

  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}>
      {content}
    </Pressable>
  );
}

function PremiumBenefit({ label }: { label: string }) {
  return (
    <View className={"flex-row items-center gap-2.5"}>
      <View className={"h-5 w-5 items-center justify-center rounded-full bg-[rgba(22,163,74,0.12)]"}>
        <Check color={designTheme.success} size={12} strokeWidth={2.6} />
      </View>
      <Text className={"flex-1 text-sm text-[#030213]"} style={fontStyles.regular}>
        {label}
      </Text>
    </View>
  );
}

function LegalLinkRow({ label, url }: { label: string; url: string }) {
  return (
    <Pressable
      accessibilityRole={"link"}
      className={"min-h-10 flex-row items-center justify-between gap-3 rounded-[12px] px-3 py-2"}
      onPress={() => openLegalUrl(url)}
      style={({ pressed }) => ({ backgroundColor: pressed ? "rgba(37,99,235,0.08)" : "transparent" })}
    >
      <View className={"flex-1"}>
        <Text className={"text-sm text-[#030213]"} style={fontStyles.medium}>
          {label}
        </Text>
        <Text className={"text-xs leading-4 text-[#6b7280]"} style={fontStyles.regular}>
          {url}
        </Text>
      </View>
      <ChevronRight color={designTheme.mutedForeground} size={17} strokeWidth={2} />
    </Pressable>
  );
}

function LegalLinksCard({ title = "Legal" }: { title?: string }) {
  return (
    <View className={"gap-1 rounded-[16px] border border-[#e5e7eb] bg-white p-2"}>
      <Text className={"px-3 pt-2 text-[13px] uppercase tracking-[0.8px] text-[#6b7280]"} style={fontStyles.medium}>
        {title}
      </Text>
      <LegalLinkRow label={"Terms of Use (EULA)"} url={TERMS_OF_USE_URL} />
      <LegalLinkRow label={"Privacy Policy"} url={PRIVACY_POLICY_URL} />
      <LegalLinkRow label={"Service Terms"} url={SERVICE_TERMS_URL} />
    </View>
  );
}

function PremiumPackageCard({
  selectedPackage,
  onPress,
  highlighted,
  disabled = false,
}: {
  selectedPackage: PurchasesPackage;
  onPress: () => void;
  highlighted: boolean;
  disabled?: boolean;
}) {
  const packageTitle = getPremiumPackageTitle(selectedPackage);
  const packagePrice = getPremiumPackagePriceLabel(selectedPackage);
  const packageDescription = getPremiumPackageDescription(selectedPackage);

  return (
    <Pressable
      className={cn(
        "gap-1.5 rounded-2xl border bg-white p-4",
        highlighted ? "border-[rgba(37,99,235,0.28)] bg-[rgba(37,99,235,0.05)]" : "border-[#e5e7eb]",
      )}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: disabled ? 0.5 : pressed ? 0.72 : 1 })}
    >
      <View className={"flex-row items-center justify-between"}>
        <Text className={"text-base text-[#030213]"} style={fontStyles.semibold}>
          {packageTitle}
        </Text>
        {highlighted ? (
          <View className={"rounded-full bg-[#2563eb] px-2 py-1"}>
            <Text className={"text-[11px] text-white"} style={fontStyles.medium}>
              Recommended
            </Text>
          </View>
        ) : null}
      </View>
      <Text className={"text-[22px] text-[#030213]"} style={fontStyles.semibold}>
        {packagePrice}
      </Text>
      <Text className={"text-[13px] leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
        {packageDescription}
      </Text>
    </Pressable>
  );
}

function formatExpirationCopy(expiresAt: string | null) {
  if (!expiresAt) {
    return null;
  }

  return `Renews or expires ${new Date(expiresAt).toLocaleDateString()}`;
}

function chunkBytesToMegabytes(value: number) {
  return Math.max(1, Math.round(value / TRANSFER_CHUNK_SIZE_STEP_BYTES));
}

function formatChunkMegabytesLabel(value: number) {
  return `${chunkBytesToMegabytes(value)} MB`;
}

function parseChunkMegabytesDraft(value: string) {
  const trimmedValue = value.trim();
  if (!/^\d+$/.test(trimmedValue)) {
    return null;
  }

  const megabytes = Number(trimmedValue);
  if (
    !Number.isInteger(megabytes) ||
    megabytes < MIN_TRANSFER_CHUNK_SIZE_MEGABYTES ||
    megabytes > MAX_TRANSFER_CHUNK_SIZE_MEGABYTES
  ) {
    return null;
  }

  return megabytes * TRANSFER_CHUNK_SIZE_STEP_BYTES;
}

type PackageIntervalUnit = "day" | "week" | "month" | "year";

interface PackageInterval {
  count: number;
  unit: PackageIntervalUnit;
}

function parseSubscriptionInterval(subscriptionPeriod: string | null): PackageInterval | null {
  if (!subscriptionPeriod) {
    return null;
  }

  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/i.exec(subscriptionPeriod);
  if (!match) {
    return null;
  }

  const [, years, months, weeks, days] = match;
  const periodValues = [
    years ? { count: Number(years), unit: "year" as const } : null,
    months ? { count: Number(months), unit: "month" as const } : null,
    weeks ? { count: Number(weeks), unit: "week" as const } : null,
    days ? { count: Number(days), unit: "day" as const } : null,
  ];

  return periodValues.find((value) => value && value.count > 0) ?? null;
}

function getPackageInterval(selectedPackage: PurchasesPackage): PackageInterval | null {
  const subscriptionInterval = parseSubscriptionInterval(selectedPackage.product.subscriptionPeriod);
  if (subscriptionInterval) {
    return subscriptionInterval;
  }

  switch (selectedPackage.packageType) {
    case PACKAGE_TYPE.ANNUAL:
      return { count: 1, unit: "year" };
    case PACKAGE_TYPE.SIX_MONTH:
      return { count: 6, unit: "month" };
    case PACKAGE_TYPE.THREE_MONTH:
      return { count: 3, unit: "month" };
    case PACKAGE_TYPE.TWO_MONTH:
      return { count: 2, unit: "month" };
    case PACKAGE_TYPE.MONTHLY:
      return { count: 1, unit: "month" };
    case PACKAGE_TYPE.WEEKLY:
      return { count: 1, unit: "week" };
    default:
      return null;
  }
}

function formatPackageInterval(interval: PackageInterval, options?: { compact?: boolean }) {
  const baseUnit =
    interval.unit === "day" ? "day" : interval.unit === "week" ? "week" : interval.unit === "month" ? "month" : "year";

  if (options?.compact) {
    return interval.count === 1 ? baseUnit : `${interval.count} ${baseUnit}s`;
  }

  if (interval.count === 1) {
    return `1 ${baseUnit}`;
  }

  return `${interval.count} ${baseUnit}s`;
}

function getPremiumPackageTitle(selectedPackage: PurchasesPackage) {
  if (selectedPackage.packageType === PACKAGE_TYPE.LIFETIME) {
    return "Lifetime access";
  }

  const interval = getPackageInterval(selectedPackage);
  if (!interval) {
    return selectedPackage.product.title || FILE_TRANSFERS_PRO_NAME;
  }

  if (interval.count === 1) {
    switch (interval.unit) {
      case "day":
        return "Daily plan";
      case "week":
        return "Weekly plan";
      case "month":
        return "Monthly plan";
      case "year":
        return "Yearly plan";
    }
  }

  return `Every ${formatPackageInterval(interval)}`;
}

function getPremiumPackagePriceLabel(selectedPackage: PurchasesPackage) {
  if (selectedPackage.packageType === PACKAGE_TYPE.LIFETIME) {
    return selectedPackage.product.priceString;
  }

  const interval = getPackageInterval(selectedPackage);
  if (!interval) {
    return selectedPackage.product.priceString;
  }

  return `${selectedPackage.product.priceString} / ${formatPackageInterval(interval, { compact: true })}`;
}

function getPremiumPackageDescription(selectedPackage: PurchasesPackage) {
  if (selectedPackage.packageType === PACKAGE_TYPE.LIFETIME) {
    return "One-time purchase through your app store account.";
  }

  const interval = getPackageInterval(selectedPackage);
  if (!interval) {
    return selectedPackage.product.description || "Billed through your app store account.";
  }

  if (interval.count === 1) {
    switch (interval.unit) {
      case "day":
        return "Billed daily through your app store account.";
      case "week":
        return "Billed weekly through your app store account.";
      case "month":
        return "Billed monthly through your app store account.";
      case "year":
        return "Billed annually through your app store account.";
    }
  }

  return `Billed every ${formatPackageInterval(interval)} through your app store account.`;
}

function getRecommendedPackageIdentifier(availablePackages: PurchasesPackage[]) {
  const packagesWithMonthlyEquivalent = availablePackages.filter((selectedPackage) =>
    Number.isFinite(selectedPackage.product.pricePerMonth),
  );

  if (packagesWithMonthlyEquivalent.length > 0) {
    return packagesWithMonthlyEquivalent.reduce((bestPackage, selectedPackage) => {
      const bestPricePerMonth = bestPackage.product.pricePerMonth ?? Number.POSITIVE_INFINITY;
      const candidatePricePerMonth = selectedPackage.product.pricePerMonth ?? Number.POSITIVE_INFINITY;
      return candidatePricePerMonth < bestPricePerMonth ? selectedPackage : bestPackage;
    }).identifier;
  }

  const annualPackage = availablePackages.find(
    (selectedPackage) => selectedPackage.packageType === PACKAGE_TYPE.ANNUAL,
  );
  return annualPackage?.identifier ?? availablePackages[0]?.identifier ?? null;
}

function waitForModalDismissal() {
  return new Promise<void>((resolve) => {
    InteractionManager.runAfterInteractions(() => resolve());
  });
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const topInset = getTabScreenTopInset(insets.top);
  const bottomPadding = getTabScreenBottomPadding(insets.bottom);
  const deviceName = useDeviceName();
  const autoAcceptKnownDevices = useAutoAcceptKnownDevices();
  const devPremiumOverrideEnabled = useDevPremiumOverrideEnabled();
  const directTransferChunkBytes = useDirectTransferChunkBytes();
  const freeTransferChunkBytes = useFreeTransferChunkBytes();
  const setDeviceName = useAppStore((state) => state.setDeviceName);
  const setAutoAcceptKnownDevices = useAppStore((state) => state.setAutoAcceptKnownDevices);
  const setDevPremiumOverrideEnabled = useAppStore((state) => state.setDevPremiumOverrideEnabled);
  const setDirectTransferChunkBytes = useAppStore((state) => state.setDirectTransferChunkBytes);
  const setFreeTransferChunkBytes = useAppStore((state) => state.setFreeTransferChunkBytes);
  const resetTransferChunkBytes = useAppStore((state) => state.resetTransferChunkBytes);
  const { data: session } = useSession();
  const sessionUser = session?.user ?? null;
  const isSignedIn = Boolean(sessionUser);
  const premiumAccess = usePremiumAccess();
  const {
    customerInfo,
    isConfigured: hasConfiguredRevenueCat,
    plans,
    isLoadingCustomerInfo,
    isLoadingOfferings,
    lastError: revenueCatError,
    presentCustomerCenter,
    purchasePackage,
    restorePurchases,
  } = useRevenueCat();
  const {
    errorMessage: appleError,
    isSigningIn: isSigningInWithApple,
    triggerAppleSignIn,
  } = useAppleSignIn({
    onSuccess: () => setPurchaseNotice(null),
  });
  const {
    errorMessage: googleError,
    isSigningIn: isSigningInWithGoogle,
    triggerGoogleSignIn,
  } = useGoogleSignIn({
    onSuccess: () => setPurchaseNotice(null),
  });
  const [draftDeviceName, setDraftDeviceName] = useState(deviceName);
  const [isEditingDeviceName, setIsEditingDeviceName] = useState(false);
  const [showPremiumDetails, setShowPremiumDetails] = useState(false);
  const [showAdvancedTransferSettings, setShowAdvancedTransferSettings] = useState(false);
  const [directChunkMegabytesDraft, setDirectChunkMegabytesDraft] = useState(() =>
    String(chunkBytesToMegabytes(directTransferChunkBytes)),
  );
  const [freeChunkMegabytesDraft, setFreeChunkMegabytesDraft] = useState(() =>
    String(chunkBytesToMegabytes(freeTransferChunkBytes)),
  );
  const [advancedTransferNotice, setAdvancedTransferNotice] = useState<{
    description: string;
    tone: "default" | "warning";
  } | null>(null);
  const [purchaseNotice, setPurchaseNotice] = useState<string | null>(null);
  const isPremium = premiumAccess.isPremium;
  const isTestFlight = isTestFlightBuild();
  const canShowLocalPremiumOverride = canUseLocalPremiumOverride();
  const recommendedPackageIdentifier = getRecommendedPackageIdentifier(plans.availablePackages);
  const isSubscriptionActionDisabled = isLoadingCustomerInfo;

  useEffect(() => {
    setDirectChunkMegabytesDraft(String(chunkBytesToMegabytes(directTransferChunkBytes)));
  }, [directTransferChunkBytes]);

  useEffect(() => {
    setFreeChunkMegabytesDraft(String(chunkBytesToMegabytes(freeTransferChunkBytes)));
  }, [freeTransferChunkBytes]);

  async function handlePurchase(selectedPackage: PurchasesPackage) {
    if (!hasConfiguredRevenueCat) {
      setPurchaseNotice("Add the RevenueCat public API keys to this build to enable live purchases.");
      setShowPremiumDetails(true);
      return;
    }

    setPurchaseNotice(null);

    const nextCustomerInfo = await purchasePackage(selectedPackage);
    if (!nextCustomerInfo) {
      setPurchaseNotice(revenueCatError ?? "Purchase cancelled.");
      return;
    }

    const nextEntitlement = mapCustomerInfoToEntitlement(nextCustomerInfo, isSignedIn);
    setPurchaseNotice(
      nextEntitlement.isPremium
        ? isSignedIn
          ? `${FILE_TRANSFERS_PRO_NAME} is active on this account.`
          : `${FILE_TRANSFERS_PRO_NAME} is active on this device. Sign in anytime to restore access on other supported devices.`
        : "The purchase completed, but the entitlement is not active yet.",
    );
  }

  async function handleRestorePurchases() {
    if (!hasConfiguredRevenueCat) {
      setPurchaseNotice("Add the RevenueCat public API keys to this build to enable live purchases.");
      setShowPremiumDetails(true);
      return;
    }

    setPurchaseNotice(null);

    const nextCustomerInfo = await restorePurchases();
    if (!nextCustomerInfo) {
      setPurchaseNotice(revenueCatError ?? "Unable to restore purchases.");
      return;
    }

    const nextEntitlement = mapCustomerInfoToEntitlement(nextCustomerInfo, isSignedIn);
    if (!nextEntitlement.isPremium) {
      setPurchaseNotice(`No active ${FILE_TRANSFERS_PRO_NAME} subscription was found to restore.`);
      return;
    }

    setPurchaseNotice(
      isSignedIn
        ? `${FILE_TRANSFERS_PRO_NAME} purchases restored on this account.`
        : `${FILE_TRANSFERS_PRO_NAME} purchases restored on this device. Sign in anytime to restore access on other supported devices.`,
    );
  }

  async function handleOpenCustomerCenter() {
    setPurchaseNotice(null);
    setShowPremiumDetails(false);
    await waitForModalDismissal();

    const customerCenterError = await presentCustomerCenter();
    if (!customerCenterError) {
      return;
    }

    setPurchaseNotice(customerCenterError);
    setShowPremiumDetails(true);
  }

  function handleSaveTransferChunkSettings() {
    const nextDirectTransferChunkBytes = parseChunkMegabytesDraft(directChunkMegabytesDraft);
    const nextFreeTransferChunkBytes = parseChunkMegabytesDraft(freeChunkMegabytesDraft);

    if (nextDirectTransferChunkBytes === null || nextFreeTransferChunkBytes === null) {
      setAdvancedTransferNotice({
        description: `Enter whole megabytes between ${MIN_TRANSFER_CHUNK_SIZE_MEGABYTES} and ${MAX_TRANSFER_CHUNK_SIZE_MEGABYTES}.`,
        tone: "warning",
      });
      return;
    }

    setDirectTransferChunkBytes(nextDirectTransferChunkBytes);
    setFreeTransferChunkBytes(nextFreeTransferChunkBytes);
    setAdvancedTransferNotice({
      description: "Saved. New nearby sessions will use the updated chunk sizes.",
      tone: "default",
    });
  }

  function handleResetTransferChunkSettings() {
    resetTransferChunkBytes();
    setAdvancedTransferNotice({
      description: "Restored the default nearby transfer chunk sizes.",
      tone: "default",
    });
  }

  return (
    <>
      <ScrollView
        className={"flex-1 bg-white px-6"}
        contentContainerStyle={{ paddingBottom: bottomPadding }}
        showsVerticalScrollIndicator={false}
        style={{ paddingTop: topInset + 16 }}
      >
        <Text className={"mb-5 text-2xl text-[#030213]"} style={fontStyles.semibold}>
          Settings
        </Text>

        <View className={"mb-6"}>
          <View className={cn("rounded-[22px] p-5", isPremium ? "bg-[#1d4ed8]" : "bg-[#2563eb]")}>
            <View className={"mb-[18px] flex-row gap-3.5"}>
              <View className={"h-14 w-14 items-center justify-center rounded-[18px] bg-[rgba(255,255,255,0.18)]"}>
                <Crown color={designTheme.primaryForeground} size={28} strokeWidth={1.9} />
              </View>
              <View className={"flex-1 gap-1"}>
                <Text className={"text-2xl text-white"} style={fontStyles.semibold}>
                  {isPremium ? `${FILE_TRANSFERS_PRO_NAME} active` : `Go ${FILE_TRANSFERS_PRO_NAME}`}
                </Text>
                <Text className={"text-sm leading-5 text-[rgba(255,255,255,0.82)]"} style={fontStyles.regular}>
                  {isPremium
                    ? "Unlimited local transfer size and speed are unlocked on this device, and hosted URLs are ready from Transfer when you sign in."
                    : "Unlimited transfer size and speed, hosted browser links from Transfer, and App Store subscription billing."}
                </Text>
              </View>
            </View>
            <PrimaryButton
              label={isPremium ? `Manage ${FILE_TRANSFERS_PRO_NAME}` : `Upgrade to ${FILE_TRANSFERS_PRO_NAME}`}
              onPress={() => {
                setShowPremiumDetails(true);
                setPurchaseNotice(null);
              }}
              tone={"inverted"}
            />
          </View>
        </View>

        <View className={"mb-6"}>
          <Text className={"mb-2.5 text-xs uppercase tracking-[0.8px] text-[#6b7280]"} style={fontStyles.medium}>
            Device
          </Text>
          <View className={"overflow-hidden rounded-[18px] border border-[#e5e7eb] bg-white"}>
            {isEditingDeviceName ? (
              <View
                className={"min-h-[72px] flex-row items-center gap-3 border-b border-[#e5e7eb] bg-white px-4 py-[14px]"}
              >
                <View className={"h-9 w-9 items-center justify-center rounded-full bg-[#f3f4f6]"}>
                  <Smartphone color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />
                </View>
                <TextInput
                  className={"min-h-6 flex-1 p-0 text-[15px] text-[#030213]"}
                  autoCapitalize={"words"}
                  onBlur={() => setIsEditingDeviceName(false)}
                  onChangeText={setDraftDeviceName}
                  onSubmitEditing={() => {
                    setDeviceName(draftDeviceName);
                    setIsEditingDeviceName(false);
                  }}
                  placeholder={"My Phone"}
                  placeholderTextColor={designTheme.mutedForeground}
                  style={fontStyles.medium}
                  value={draftDeviceName}
                />
                <SecondaryButton
                  label={"Done"}
                  onPress={() => {
                    setDeviceName(draftDeviceName);
                    setIsEditingDeviceName(false);
                  }}
                />
              </View>
            ) : (
              <SettingItem
                description={"Your device name shown to nearby people"}
                icon={<Smartphone color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />}
                label={deviceName}
                onPress={() => {
                  setDraftDeviceName(deviceName);
                  setIsEditingDeviceName(true);
                }}
              />
            )}
          </View>
        </View>

        <View className={"mb-6"}>
          <Text className={"mb-2.5 text-xs uppercase tracking-[0.8px] text-[#6b7280]"} style={fontStyles.medium}>
            Premium Features
          </Text>
          <View className={"overflow-hidden rounded-[18px] border border-[#e5e7eb] bg-white"}>
            <SettingItem
              description={
                isPremium
                  ? "Create hosted URLs from Transfer and reshare or delete them from Files."
                  : `${FILE_TRANSFERS_PRO_NAME} adds hosted URLs from Transfer and management in Files.`
              }
              icon={<Link color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />}
              label={"Hosted Links"}
            />
            {!isPremium ? (
              <SettingItem
                description={`Restore ${FILE_TRANSFERS_PRO_NAME} from the current store account`}
                icon={<RefreshCw color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />}
                label={"Restore Purchase"}
                onPress={() => {
                  void handleRestorePurchases();
                }}
              />
            ) : null}
          </View>
        </View>

        <View className={"mb-6"}>
          <Text className={"mb-2.5 text-xs uppercase tracking-[0.8px] text-[#6b7280]"} style={fontStyles.medium}>
            Transfers
          </Text>
          <View className={"overflow-hidden rounded-[18px] border border-[#e5e7eb] bg-white"}>
            <SettingItem
              action={
                <Switch
                  ios_backgroundColor={designTheme.border}
                  onValueChange={setAutoAcceptKnownDevices}
                  thumbColor={
                    Platform.OS === "android" && autoAcceptKnownDevices ? designTheme.primaryForeground : undefined
                  }
                  trackColor={{ false: designTheme.border, true: designTheme.primary }}
                  value={autoAcceptKnownDevices}
                />
              }
              description={"Skip approval for devices you've used before"}
              icon={<Shield color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />}
              label={"Auto-accept from known devices"}
            />
            <SettingItem
              action={
                <View className={"flex-row items-center gap-2"}>
                  <Text className={"text-[13px] text-[#6b7280]"} style={fontStyles.medium}>
                    {showAdvancedTransferSettings ? "Hide" : "Show"}
                  </Text>
                  <View style={showAdvancedTransferSettings ? { transform: [{ rotate: "90deg" }] } : undefined}>
                    <ChevronRight color={designTheme.mutedForeground} size={18} strokeWidth={2} />
                  </View>
                </View>
              }
              description={`Premium/direct ${formatChunkMegabytesLabel(directTransferChunkBytes)} • Free ${formatChunkMegabytesLabel(freeTransferChunkBytes)}`}
              icon={<SlidersHorizontal color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />}
              label={"Advanced transfer settings"}
              onPress={() => {
                setAdvancedTransferNotice(null);
                setShowAdvancedTransferSettings((current) => !current);
              }}
            />
          </View>
          {showAdvancedTransferSettings ? (
            <View className={"mt-3 gap-3 rounded-[18px] border border-[#e5e7eb] bg-white p-4"}>
              <Text className={"text-lg text-[#030213]"} style={fontStyles.semibold}>
                Advanced transfer settings
              </Text>
              <Text className={"text-sm leading-5 text-[#6b7280]"} style={fontStyles.regular}>
                Applies to new nearby send and receive sessions. Larger chunks reduce request overhead, while smaller
                chunks retry less data after interruptions.
              </Text>

              <View className={"gap-2.5"}>
                <View className={"gap-1"}>
                  <Text className={"text-[15px] text-[#030213]"} style={fontStyles.medium}>
                    Premium/direct chunk size
                  </Text>
                  <Text className={"text-[13px] leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
                    Used for premium sends and all incoming nearby transfers.
                  </Text>
                </View>
                <View
                  className={
                    "min-h-12 flex-row items-center gap-3 rounded-[14px] border border-[#e5e7eb] bg-[#f3f4f6] px-[14px]"
                  }
                >
                  <TextInput
                    className={"min-h-6 flex-1 p-0 text-[15px] text-[#030213]"}
                    keyboardType={"number-pad"}
                    onChangeText={setDirectChunkMegabytesDraft}
                    placeholder={"45"}
                    placeholderTextColor={designTheme.mutedForeground}
                    style={fontStyles.medium}
                    value={directChunkMegabytesDraft}
                  />
                  <Text className={"text-[13px] text-[#6b7280]"} style={fontStyles.medium}>
                    MB
                  </Text>
                </View>
              </View>

              <View className={"gap-2.5"}>
                <View className={"gap-1"}>
                  <Text className={"text-[15px] text-[#030213]"} style={fontStyles.medium}>
                    Free sender chunk size
                  </Text>
                  <Text className={"text-[13px] leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
                    Used when the sender stays on the free tier for nearby transfers.
                  </Text>
                </View>
                <View
                  className={
                    "min-h-12 flex-row items-center gap-3 rounded-[14px] border border-[#e5e7eb] bg-[#f3f4f6] px-[14px]"
                  }
                >
                  <TextInput
                    className={"min-h-6 flex-1 p-0 text-[15px] text-[#030213]"}
                    keyboardType={"number-pad"}
                    onChangeText={setFreeChunkMegabytesDraft}
                    placeholder={"1"}
                    placeholderTextColor={designTheme.mutedForeground}
                    style={fontStyles.medium}
                    value={freeChunkMegabytesDraft}
                  />
                  <Text className={"text-[13px] text-[#6b7280]"} style={fontStyles.medium}>
                    MB
                  </Text>
                </View>
              </View>

              {advancedTransferNotice ? (
                <InlineNotice
                  description={advancedTransferNotice.description}
                  title={"Transfer tuning"}
                  tone={advancedTransferNotice.tone}
                />
              ) : null}

              <View className={"gap-2.5"}>
                <PrimaryButton label={"Save chunk sizes"} onPress={handleSaveTransferChunkSettings} />
                <SecondaryButton label={"Reset defaults"} onPress={handleResetTransferChunkSettings} />
              </View>
            </View>
          ) : null}
        </View>

        <View className={"mb-6"}>
          <Text className={"mb-2.5 text-xs uppercase tracking-[0.8px] text-[#6b7280]"} style={fontStyles.medium}>
            General
          </Text>
          <View className={"overflow-hidden rounded-[18px] border border-[#e5e7eb] bg-white"}>
            <SettingItem
              icon={<HelpCircle color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />}
              label={"Help & FAQ"}
              onPress={() => {
                Alert.alert(
                  "Help & FAQ",
                  "Nearby transfers only work when both devices are on the same Wi-Fi network. If one device is on cellular, guest Wi-Fi, or a different router, it may not appear.\n\nFree senders can transfer up to 100 MB at up to 5 MB/s over nearby Wi-Fi. Premium senders remove those limits and can still send larger files to free receivers.",
                );
              }}
            />
            <SettingItem
              description={`Version ${Constants.expoConfig?.version ?? "1.0.0"}`}
              icon={<Info color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />}
              label={"About"}
              onPress={() => {
                Alert.alert("About", `File Transfers\nVersion ${Constants.expoConfig?.version ?? "1.0.0"}`);
              }}
            />
          </View>
        </View>

        <View className={"mb-6"}>
          <LegalLinksCard />
        </View>

        <View className={"mb-6"}>
          <Text className={"mb-2.5 text-xs uppercase tracking-[0.8px] text-[#6b7280]"} style={fontStyles.medium}>
            FAQ
          </Text>
          <View className={"gap-3 rounded-[18px] border border-[#e5e7eb] bg-white p-4"}>
            <View className={"gap-1.5"}>
              <Text className={"text-[15px] text-[#030213]"} style={fontStyles.medium}>
                Why can't I see the other device?
              </Text>
              <Text className={"text-sm leading-5 text-[#6b7280]"} style={fontStyles.regular}>
                Nearby transfers only work when both devices are connected to the same Wi-Fi network. If one device is
                on cellular, guest Wi-Fi, or a different router, discovery will usually fail.
              </Text>
            </View>
          </View>
        </View>

        {canShowLocalPremiumOverride ? (
          <View className={"mb-6"}>
            <Text className={"mb-2.5 text-xs uppercase tracking-[0.8px] text-[#6b7280]"} style={fontStyles.medium}>
              {isTestFlight && !__DEV__ ? "Preview" : "Developer"}
            </Text>
            <View className={"overflow-hidden rounded-[18px] border border-[#e5e7eb] bg-white"}>
              <SettingItem
                action={
                  <Switch
                    ios_backgroundColor={designTheme.border}
                    onValueChange={setDevPremiumOverrideEnabled}
                    trackColor={{ false: designTheme.border, true: designTheme.primary }}
                    value={devPremiumOverrideEnabled}
                  />
                }
                description={
                  isTestFlight && !__DEV__
                    ? "TestFlight only. Forces local premium feature gating on this device."
                    : "Debug only. Forces local premium feature gating on this device."
                }
                icon={<Crown color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />}
                label={"Premium override"}
              />
            </View>
          </View>
        ) : null}

        <View className={"mt-2 rounded-2xl bg-[#f9fafb] p-4"}>
          <Text className={"text-xs leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
            Free senders stay anonymous over nearby WiFi with up to 100 MB and 5 MB/s. Premium removes the sender limits
            and adds hosted URLs you create from Transfer and manage in Files.
          </Text>
        </View>
      </ScrollView>

      <Modal
        animationType={"fade"}
        onRequestClose={() => setShowPremiumDetails(false)}
        transparent
        visible={showPremiumDetails}
      >
        <View className={"flex-1 items-center justify-center bg-[rgba(3,2,19,0.42)] p-6"}>
          <View className={"max-h-[88%] w-full rounded-[24px] bg-white pt-5"}>
            <Pressable
              className={"mr-4 h-9 w-9 self-end items-center justify-center"}
              hitSlop={12}
              onPress={() => setShowPremiumDetails(false)}
              style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
            >
              <X color={designTheme.mutedForeground} size={18} strokeWidth={2.2} />
            </Pressable>

            <ScrollView contentContainerClassName={"gap-3.5 px-5 pb-5"} showsVerticalScrollIndicator={false}>
              <View
                className={"h-16 w-16 self-center items-center justify-center rounded-full bg-[rgba(37,99,235,0.1)]"}
              >
                <Crown color={designTheme.primary} size={28} strokeWidth={1.9} />
              </View>
              <Text className={"text-center text-[28px] text-[#030213]"} style={fontStyles.semibold}>
                {FILE_TRANSFERS_PRO_NAME}
              </Text>
              <Text className={"text-center text-sm leading-5 text-[#6b7280]"} style={fontStyles.regular}>
                Subscribe through your App Store account to unlock faster local transfers and hosted browser links.
              </Text>

              <View className={"mt-1 gap-2.5"}>
                <PremiumBenefit label={"Unlimited local transfer size and speed"} />
                <PremiumBenefit label={"Hosted file links in the browser"} />
                <PremiumBenefit label={"Up to 10 GB per file"} />
              </View>

              <LegalLinksCard title={"Subscription Legal"} />
              <InlineNotice
                description={
                  "Subscriptions renew automatically until canceled and are billed through your App Store account. You can manage or cancel from your App Store subscriptions."
                }
                title={"Subscription terms"}
              />

              {sessionUser ? (
                <InlineNotice description={sessionUser?.email ?? "Signed in"} title={"App account linked"} />
              ) : (
                <InlineNotice
                  description={`You can subscribe without signing in. Signing in is optional and lets you restore ${FILE_TRANSFERS_PRO_NAME} on other supported devices.`}
                  title={"Account optional"}
                />
              )}

              {formatExpirationCopy(premiumAccess.entitlement.expiresAt) ? (
                <InlineNotice
                  description={formatExpirationCopy(premiumAccess.entitlement.expiresAt) ?? ""}
                  title={`${FILE_TRANSFERS_PRO_NAME} renewal`}
                />
              ) : null}

              <View className={"gap-3"}>
                {hasConfiguredRevenueCat ? (
                  isLoadingOfferings && !plans.availablePackages.length ? (
                    <View className={"flex-row items-center gap-3"}>
                      <ActivityIndicator color={designTheme.primary} />
                      <Text className={"text-sm text-[#6b7280]"} style={fontStyles.regular}>
                        Loading {FILE_TRANSFERS_PRO_NAME} plans...
                      </Text>
                    </View>
                  ) : plans.availablePackages.length ? (
                    plans.availablePackages.map((selectedPackage) => (
                      <PremiumPackageCard
                        key={selectedPackage.identifier}
                        disabled={isSubscriptionActionDisabled}
                        highlighted={selectedPackage.identifier === recommendedPackageIdentifier}
                        onPress={() => {
                          void handlePurchase(selectedPackage);
                        }}
                        selectedPackage={selectedPackage}
                      />
                    ))
                  ) : (
                    <InlineNotice
                      description={
                        "Create a current offering in RevenueCat and attach the subscription packages you want to sell in this build."
                      }
                      title={"Offering setup required"}
                      tone={"warning"}
                    />
                  )
                ) : (
                  <InlineNotice
                    description={"Add the RevenueCat public API keys to this build to enable live purchases."}
                    title={"RevenueCat keys missing"}
                    tone={"warning"}
                  />
                )}

                {customerInfo?.activeSubscriptions.length ? (
                  <InlineNotice
                    description={customerInfo.activeSubscriptions.join(", ")}
                    title={"Active store products"}
                  />
                ) : null}

                {isPremium ? (
                  <PrimaryButton
                    disabled={!hasConfiguredRevenueCat || isLoadingCustomerInfo}
                    label={"Open Customer Center"}
                    onPress={() => {
                      void handleOpenCustomerCenter();
                    }}
                  />
                ) : null}

                {hasConfiguredRevenueCat && !isPremium ? (
                  <SecondaryButton
                    disabled={isSubscriptionActionDisabled}
                    label={"Restore purchases"}
                    onPress={() => {
                      void handleRestorePurchases();
                    }}
                  />
                ) : null}

                {premiumAccess.entitlement.managementUrl ? (
                  <SecondaryButton
                    label={"Open store management"}
                    onPress={() => {
                      void Linking.openURL(premiumAccess.entitlement.managementUrl ?? "");
                    }}
                  />
                ) : null}

                {sessionUser ? (
                  <SecondaryButton
                    label={"Sign out"}
                    onPress={() => {
                      void signOut();
                    }}
                    tone={"danger"}
                  />
                ) : (
                  <>
                    <ContinueWithAppleButton
                      disabled={isSigningInWithApple}
                      onPress={() => {
                        void triggerAppleSignIn();
                      }}
                      type={"signIn"}
                    />
                    <ContinueWithGoogleButton
                      disabled={isSigningInWithGoogle}
                      label={"Sign in with Google"}
                      onPress={() => {
                        void triggerGoogleSignIn();
                      }}
                    />
                  </>
                )}
              </View>

              {purchaseNotice ? (
                <InlineNotice description={purchaseNotice} title={`${FILE_TRANSFERS_PRO_NAME} status`} />
              ) : null}
              {!purchaseNotice && revenueCatError ? (
                <InlineNotice description={revenueCatError} title={"RevenueCat"} tone={"danger"} />
              ) : null}
              {appleError ? <InlineNotice description={appleError} title={"Apple sign-in"} tone={"danger"} /> : null}
              {googleError ? <InlineNotice description={googleError} title={"Google sign-in"} tone={"danger"} /> : null}

              <SecondaryButton label={"Done"} onPress={() => setShowPremiumDetails(false)} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}
