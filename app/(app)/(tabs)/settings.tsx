import Constants from "expo-constants";
import { File } from "expo-file-system";
import * as Linking from "expo-linking";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { PurchasesPackage } from "react-native-purchases";
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
import { useGoogleSignIn } from "@/hooks/use-google-sign-in";
import { useCompleteHostedUpload, useCreateHostedUpload, useDeleteHostedFile, useHostedFiles } from "@/hooks/queries";
import { usePremiumAccess } from "@/hooks/use-premium-access";
import { useAppleSignIn } from "@/hooks/use-apple-sign-in";
import { signOut, useSession } from "@/lib/auth-client";
import { getTabScreenBottomPadding, getTabScreenTopInset } from "@/lib/design/tab-screen-insets";
import { designFonts, designTheme } from "@/lib/design/theme";
import { pickTransferFiles } from "@/lib/file-transfer";
import {
  MAX_TRANSFER_CHUNK_SIZE_MEGABYTES,
  MIN_TRANSFER_CHUNK_SIZE_MEGABYTES,
  TRANSFER_CHUNK_SIZE_STEP_BYTES,
} from "@/lib/file-transfer/constants";
import { getPaywallResultMessage, mapCustomerInfoToEntitlement, REVENUECAT_PAYWALL_RESULT } from "@/lib/purchases";
import { FILE_TRANSFERS_PRO_NAME, PREMIUM_PRODUCT_IDS } from "@/lib/subscriptions";
import { useRevenueCat } from "@/providers/revenuecat-provider";
import {
  useAppStore,
  useAutoAcceptKnownDevices,
  useDeviceName,
  useDevPremiumOverrideEnabled,
  useDirectTransferChunkBytes,
  useFreeTransferChunkBytes,
} from "@/store";

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
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        tone === "inverted" ? styles.primaryButtonInverted : null,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Text style={[styles.primaryButtonLabel, tone === "inverted" ? styles.primaryButtonLabelInverted : null]}>
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
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.secondaryButton,
        tone === "danger" ? styles.dangerButton : null,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Text style={[styles.secondaryButtonLabel, tone === "danger" ? styles.dangerButtonLabel : null]}>{label}</Text>
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
      style={[
        styles.inlineNotice,
        tone === "warning" ? styles.warningNotice : null,
        tone === "danger" ? styles.dangerNotice : null,
      ]}
    >
      <Text style={styles.inlineNoticeTitle}>{title}</Text>
      <Text style={styles.inlineNoticeDescription}>{description}</Text>
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
    <View style={styles.settingItem}>
      <View style={styles.settingIconWrap}>{icon}</View>
      <View style={styles.settingCopy}>
        <Text style={styles.settingLabel}>{label}</Text>
        {description ? <Text style={styles.settingDescription}>{description}</Text> : null}
      </View>
      {action ?? (onPress ? <ChevronRight color={designTheme.mutedForeground} size={18} strokeWidth={2} /> : null)}
    </View>
  );

  if (!onPress) {
    return content;
  }

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [pressed ? styles.pressed : null]}>
      {content}
    </Pressable>
  );
}

function PremiumBenefit({ label }: { label: string }) {
  return (
    <View style={styles.benefitRow}>
      <View style={styles.benefitIconWrap}>
        <Check color={designTheme.success} size={12} strokeWidth={2.6} />
      </View>
      <Text style={styles.benefitLabel}>{label}</Text>
    </View>
  );
}

function PremiumPackageCard({
  selectedPackage,
  onPress,
  highlighted,
}: {
  selectedPackage: PurchasesPackage;
  onPress: () => void;
  highlighted: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.packageCard,
        highlighted ? styles.packageCardHighlighted : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <View style={styles.packageHeader}>
        <Text style={styles.packageTitle}>{selectedPackage.product.title}</Text>
        {highlighted ? (
          <View style={styles.packageBadge}>
            <Text style={styles.packageBadgeLabel}>Recommended</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.packagePrice}>{selectedPackage.product.priceString}</Text>
      {selectedPackage.product.description ? (
        <Text style={styles.packageDescription}>{selectedPackage.product.description}</Text>
      ) : null}
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
  const premiumAccess = usePremiumAccess();
  const {
    customerInfo,
    isConfigured: hasConfiguredRevenueCat,
    plans,
    isLoadingCustomerInfo,
    isLoadingOfferings,
    lastError: revenueCatError,
    presentCustomerCenter,
    presentPaywall,
    purchasePackage,
    refreshCustomerInfo,
    restorePurchases,
  } = useRevenueCat();
  const hostedFilesQuery = useHostedFiles(Boolean(session?.user && premiumAccess.isPremium));
  const createHostedUploadMutation = useCreateHostedUpload();
  const completeHostedUploadMutation = useCompleteHostedUpload();
  const deleteHostedFileMutation = useDeleteHostedFile();
  const { errorMessage: appleError, isSigningIn: isSigningInWithApple, triggerAppleSignIn } = useAppleSignIn();
  const { errorMessage: googleError, isSigningIn: isSigningInWithGoogle, triggerGoogleSignIn } = useGoogleSignIn();
  const [draftDeviceName, setDraftDeviceName] = useState(deviceName);
  const [isEditingDeviceName, setIsEditingDeviceName] = useState(false);
  const [showPremiumDetails, setShowPremiumDetails] = useState(false);
  const [wantsHostedLinksPanel, setWantsHostedLinksPanel] = useState(false);
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
  const [hostedNotice, setHostedNotice] = useState<string | null>(null);
  const [hostedPasscode, setHostedPasscode] = useState("");
  const isPremium = premiumAccess.isPremium;
  const showHostedLinksPanel = wantsHostedLinksPanel && isPremium;

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

    const nextEntitlement = mapCustomerInfoToEntitlement(nextCustomerInfo, Boolean(session?.user));
    setPurchaseNotice(
      nextEntitlement.isPremium
        ? session?.user
          ? `${FILE_TRANSFERS_PRO_NAME} is active on this account.`
          : `${FILE_TRANSFERS_PRO_NAME} is active on this device. Sign in when you want hosted links or cross-device restore.`
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

    const nextEntitlement = mapCustomerInfoToEntitlement(nextCustomerInfo, Boolean(session?.user));
    if (!nextEntitlement.isPremium) {
      setPurchaseNotice(`No active ${FILE_TRANSFERS_PRO_NAME} subscription was found to restore.`);
      return;
    }

    setPurchaseNotice(
      session?.user
        ? "Purchases restored."
        : `${FILE_TRANSFERS_PRO_NAME} is active on this device. Sign in when you want hosted links or cross-device restore.`,
    );
  }

  async function handlePresentPaywall() {
    if (!hasConfiguredRevenueCat) {
      setPurchaseNotice("Add the RevenueCat public API keys to this build to enable live purchases.");
      setShowPremiumDetails(true);
      return;
    }

    setPurchaseNotice(null);

    const paywallResult = await presentPaywall();
    if (!paywallResult) {
      setPurchaseNotice(revenueCatError ?? "Unable to open the RevenueCat paywall.");
      return;
    }

    if (
      (paywallResult === REVENUECAT_PAYWALL_RESULT.PURCHASED || paywallResult === REVENUECAT_PAYWALL_RESULT.RESTORED) &&
      !session?.user
    ) {
      setPurchaseNotice(
        `${FILE_TRANSFERS_PRO_NAME} is active on this device. Sign in when you want hosted links or cross-device restore.`,
      );
      return;
    }

    if (paywallResult !== REVENUECAT_PAYWALL_RESULT.ERROR) {
      void refreshCustomerInfo({ silent: true });
    }

    setPurchaseNotice(getPaywallResultMessage(paywallResult));
  }

  async function handleOpenCustomerCenter() {
    await presentCustomerCenter();

    if (revenueCatError) {
      setPurchaseNotice(revenueCatError);
    }
  }

  async function handleCreateHostedUpload() {
    if (!session?.user) {
      setShowPremiumDetails(true);
      setHostedNotice("Sign in first to use hosted links.");
      return;
    }

    if (!isPremium) {
      setShowPremiumDetails(true);
      setHostedNotice(`${FILE_TRANSFERS_PRO_NAME} is required to create hosted links.`);
      return;
    }

    const files = await pickTransferFiles();
    const [selectedFile] = files;

    if (!selectedFile) {
      return;
    }

    const trimmedPasscode = hostedPasscode.trim();
    const passcode = trimmedPasscode.length > 0 ? trimmedPasscode : null;

    try {
      setHostedNotice(null);
      const createResult = await createHostedUploadMutation.mutateAsync({
        fileName: selectedFile.name,
        mimeType: selectedFile.mimeType,
        sizeBytes: selectedFile.sizeBytes,
        passcode,
      });

      const uploadFile = new File(selectedFile.uri);
      const uploadResponse = await fetch(createResult.uploadUrl, {
        method: createResult.uploadMethod,
        headers: createResult.uploadHeaders,
        body: uploadFile,
      });

      if (!uploadResponse.ok) {
        setHostedNotice(`Upload failed with status ${uploadResponse.status}.`);
        return;
      }

      const completed = await completeHostedUploadMutation.mutateAsync({
        hostedFileId: createResult.hostedFile.id,
      });

      setHostedPasscode("");
      setHostedNotice(`Hosted link ready: ${completed.downloadPageUrl}`);
      setWantsHostedLinksPanel(true);
    } catch (error) {
      setHostedNotice(error instanceof Error ? error.message : "Unable to upload the hosted file.");
    }
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
        contentContainerStyle={{ paddingBottom: bottomPadding }}
        showsVerticalScrollIndicator={false}
        style={[styles.root, { paddingTop: topInset + 16 }]}
      >
        <Text style={styles.title}>Settings</Text>

        <View style={styles.section}>
          <View style={[styles.heroCard, isPremium ? styles.heroCardActive : null]}>
            <View style={styles.heroHeader}>
              <View style={styles.heroIconWrap}>
                <Crown color={designTheme.primaryForeground} size={28} strokeWidth={1.9} />
              </View>
              <View style={styles.heroCopy}>
                <Text style={styles.heroTitle}>
                  {isPremium ? `${FILE_TRANSFERS_PRO_NAME} active` : `Go ${FILE_TRANSFERS_PRO_NAME}`}
                </Text>
                <Text style={styles.heroDescription}>
                  {isPremium
                    ? "Unlimited local transfer size and speed are unlocked on this device, and hosted links are ready when you sign in."
                    : "Unlimited transfer size and speed, hosted browser links, and RevenueCat billing."}
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

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Device</Text>
          <View style={styles.group}>
            {isEditingDeviceName ? (
              <View style={styles.editRow}>
                <View style={styles.settingIconWrap}>
                  <Smartphone color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />
                </View>
                <TextInput
                  autoCapitalize={"words"}
                  onBlur={() => setIsEditingDeviceName(false)}
                  onChangeText={setDraftDeviceName}
                  onSubmitEditing={() => {
                    setDeviceName(draftDeviceName);
                    setIsEditingDeviceName(false);
                  }}
                  placeholder={"My Phone"}
                  placeholderTextColor={designTheme.mutedForeground}
                  style={styles.deviceInput}
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

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Premium Features</Text>
          <View style={styles.group}>
            <SettingItem
              description={
                isPremium ? "Create and manage browser download links" : `${FILE_TRANSFERS_PRO_NAME} feature`
              }
              icon={<Link color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />}
              label={"Hosted Links"}
              onPress={() => {
                if (!isPremium) {
                  setShowPremiumDetails(true);
                  setHostedNotice(
                    session?.user
                      ? `${FILE_TRANSFERS_PRO_NAME} is required to create hosted links.`
                      : `Sign in first, then upgrade to ${FILE_TRANSFERS_PRO_NAME} to create hosted links.`,
                  );
                  return;
                }

                setWantsHostedLinksPanel((current) => !current);
              }}
            />
            <SettingItem
              description={`Restore ${FILE_TRANSFERS_PRO_NAME} from the current store account`}
              icon={<RefreshCw color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />}
              label={"Restore Purchase"}
              onPress={() => {
                void handleRestorePurchases();
              }}
            />
          </View>
        </View>

        {showHostedLinksPanel ? (
          <View style={styles.section}>
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>Hosted links</Text>
              <Text style={styles.panelCopy}>Create a browser download link with an optional 6-digit passcode.</Text>
              <TextInput
                keyboardType={"number-pad"}
                maxLength={6}
                onChangeText={setHostedPasscode}
                placeholder={"Optional 6-digit passcode"}
                placeholderTextColor={designTheme.mutedForeground}
                style={styles.hostedInput}
                value={hostedPasscode}
              />
              <PrimaryButton
                disabled={createHostedUploadMutation.isPending || completeHostedUploadMutation.isPending}
                label={
                  createHostedUploadMutation.isPending || completeHostedUploadMutation.isPending
                    ? "Uploading..."
                    : "Create hosted link"
                }
                onPress={() => {
                  void handleCreateHostedUpload();
                }}
              />

              {hostedNotice ? <InlineNotice description={hostedNotice} title={"Hosted link"} /> : null}
              {hostedFilesQuery.error ? (
                <InlineNotice
                  description={
                    hostedFilesQuery.error instanceof Error
                      ? hostedFilesQuery.error.message
                      : "Unable to load hosted links."
                  }
                  title={"Hosted links"}
                  tone={"danger"}
                />
              ) : null}

              <View style={styles.hostedList}>
                {hostedFilesQuery.data?.length ? (
                  hostedFilesQuery.data.map((hostedFile) => (
                    <View key={hostedFile.id} style={styles.hostedFileRow}>
                      <View style={styles.hostedFileCopy}>
                        <Text numberOfLines={1} style={styles.hostedFileName}>
                          {hostedFile.fileName}
                        </Text>
                        <Text style={styles.hostedFileMeta}>
                          Expires {new Date(hostedFile.expiresAt).toLocaleDateString()}
                          {hostedFile.requiresPasscode ? " • Passcode" : ""}
                        </Text>
                      </View>
                      <View style={styles.hostedActions}>
                        <SecondaryButton
                          label={"Open"}
                          onPress={() => {
                            void Linking.openURL(hostedFile.downloadPageUrl);
                          }}
                        />
                        <SecondaryButton
                          label={deleteHostedFileMutation.isPending ? "Deleting..." : "Delete"}
                          onPress={() => {
                            void deleteHostedFileMutation.mutateAsync({ hostedFileId: hostedFile.id });
                          }}
                          tone={"danger"}
                          disabled={deleteHostedFileMutation.isPending}
                        />
                      </View>
                    </View>
                  ))
                ) : (
                  <InlineNotice description={"You have not created any hosted links yet."} title={"No hosted links"} />
                )}
              </View>
            </View>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Transfers</Text>
          <View style={styles.group}>
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
                <View style={styles.advancedToggleWrap}>
                  <Text style={styles.advancedToggleLabel}>{showAdvancedTransferSettings ? "Hide" : "Show"}</Text>
                  <View style={showAdvancedTransferSettings ? styles.advancedToggleChevronExpanded : null}>
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
            <View style={[styles.panel, styles.advancedPanel]}>
              <Text style={styles.panelTitle}>Advanced transfer settings</Text>
              <Text style={styles.panelCopy}>
                Applies to new nearby send and receive sessions. Larger chunks reduce request overhead, while smaller
                chunks retry less data after interruptions.
              </Text>

              <View style={styles.advancedField}>
                <View style={styles.advancedFieldCopy}>
                  <Text style={styles.advancedFieldLabel}>Premium/direct chunk size</Text>
                  <Text style={styles.advancedFieldDescription}>
                    Used for premium sends and all incoming nearby transfers.
                  </Text>
                </View>
                <View style={styles.advancedInputWrap}>
                  <TextInput
                    keyboardType={"number-pad"}
                    onChangeText={setDirectChunkMegabytesDraft}
                    placeholder={"45"}
                    placeholderTextColor={designTheme.mutedForeground}
                    style={styles.advancedInput}
                    value={directChunkMegabytesDraft}
                  />
                  <Text style={styles.advancedInputSuffix}>MB</Text>
                </View>
              </View>

              <View style={styles.advancedField}>
                <View style={styles.advancedFieldCopy}>
                  <Text style={styles.advancedFieldLabel}>Free sender chunk size</Text>
                  <Text style={styles.advancedFieldDescription}>
                    Used when the sender stays on the free tier for nearby transfers.
                  </Text>
                </View>
                <View style={styles.advancedInputWrap}>
                  <TextInput
                    keyboardType={"number-pad"}
                    onChangeText={setFreeChunkMegabytesDraft}
                    placeholder={"1"}
                    placeholderTextColor={designTheme.mutedForeground}
                    style={styles.advancedInput}
                    value={freeChunkMegabytesDraft}
                  />
                  <Text style={styles.advancedInputSuffix}>MB</Text>
                </View>
              </View>

              {advancedTransferNotice ? (
                <InlineNotice
                  description={advancedTransferNotice.description}
                  title={"Transfer tuning"}
                  tone={advancedTransferNotice.tone}
                />
              ) : null}

              <View style={styles.advancedActions}>
                <PrimaryButton label={"Save chunk sizes"} onPress={handleSaveTransferChunkSettings} />
                <SecondaryButton label={"Reset defaults"} onPress={handleResetTransferChunkSettings} />
              </View>
            </View>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>General</Text>
          <View style={styles.group}>
            <SettingItem
              icon={<HelpCircle color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />}
              label={"Help & FAQ"}
              onPress={() => {
                Alert.alert(
                  "Help & FAQ",
                  "Free senders can transfer up to 100 MB at up to 5 MB/s over nearby WiFi. Premium senders remove those limits and can still send larger files to free receivers.",
                );
              }}
            />
            <SettingItem
              description={`Version ${Constants.expoConfig?.version ?? "1.0.0"}`}
              icon={<Info color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />}
              label={"About"}
              onPress={() => {
                Alert.alert("About", `File Share\nVersion ${Constants.expoConfig?.version ?? "1.0.0"}`);
              }}
            />
          </View>
        </View>

        {__DEV__ ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Developer</Text>
            <View style={styles.group}>
              <SettingItem
                action={
                  <Switch
                    ios_backgroundColor={designTheme.border}
                    onValueChange={setDevPremiumOverrideEnabled}
                    trackColor={{ false: designTheme.border, true: designTheme.primary }}
                    value={devPremiumOverrideEnabled}
                  />
                }
                description={"Debug only. Forces local premium feature gating on this device."}
                icon={<Crown color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />}
                label={"Premium override"}
              />
            </View>
          </View>
        ) : null}

        <View style={styles.footerNote}>
          <Text style={styles.footerNoteText}>
            Free senders stay anonymous over nearby WiFi with up to 100 MB and 5 MB/s. Premium removes the sender limits
            and adds hosted links.
          </Text>
        </View>
      </ScrollView>

      <Modal
        animationType={"fade"}
        onRequestClose={() => setShowPremiumDetails(false)}
        transparent
        visible={showPremiumDetails}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Pressable
              hitSlop={12}
              onPress={() => setShowPremiumDetails(false)}
              style={({ pressed }) => [styles.modalCloseButton, pressed ? styles.pressed : null]}
            >
              <X color={designTheme.mutedForeground} size={18} strokeWidth={2.2} />
            </Pressable>

            <ScrollView contentContainerStyle={styles.modalContent} showsVerticalScrollIndicator={false}>
              <View style={styles.modalHeroIcon}>
                <Crown color={designTheme.primary} size={28} strokeWidth={1.9} />
              </View>
              <Text style={styles.modalTitle}>{FILE_TRANSFERS_PRO_NAME}</Text>
              <Text style={styles.modalDescription}>
                RevenueCat manages the subscription lifecycle while the app keeps transfer speed and hosted-link access
                in sync with customer info.
              </Text>

              <View style={styles.modalBenefits}>
                <PremiumBenefit label={"Unlimited local transfer size and speed"} />
                <PremiumBenefit label={"Hosted file links in the browser"} />
                <PremiumBenefit label={"Up to 10 GB per file"} />
              </View>

              {session?.user ? (
                <InlineNotice description={session.user.email ?? "Signed in"} title={"App account linked"} />
              ) : (
                <InlineNotice
                  description={
                    "Buy or restore on this device now. Sign in only when you want hosted links or cross-device restore."
                  }
                  title={"No app account required"}
                />
              )}

              {formatExpirationCopy(premiumAccess.entitlement.expiresAt) ? (
                <InlineNotice
                  description={formatExpirationCopy(premiumAccess.entitlement.expiresAt) ?? ""}
                  title={`${FILE_TRANSFERS_PRO_NAME} renewal`}
                />
              ) : null}

              <View style={styles.modalSection}>
                {hasConfiguredRevenueCat ? (
                  isLoadingOfferings && !plans.availablePackages.length ? (
                    <View style={styles.loadingRow}>
                      <ActivityIndicator color={designTheme.primary} />
                      <Text style={styles.loadingLabel}>Loading {FILE_TRANSFERS_PRO_NAME} plans...</Text>
                    </View>
                  ) : plans.availablePackages.length ? (
                    plans.availablePackages.map((selectedPackage, index) => (
                      <PremiumPackageCard
                        key={selectedPackage.identifier}
                        highlighted={selectedPackage.product.identifier === PREMIUM_PRODUCT_IDS.yearly || index === 0}
                        onPress={() => {
                          void handlePurchase(selectedPackage);
                        }}
                        selectedPackage={selectedPackage}
                      />
                    ))
                  ) : (
                    <InlineNotice
                      description={`Create a current offering in RevenueCat and attach products ${PREMIUM_PRODUCT_IDS.monthly} and ${PREMIUM_PRODUCT_IDS.yearly}.`}
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

                <PrimaryButton
                  disabled={!hasConfiguredRevenueCat || isLoadingCustomerInfo}
                  label={isPremium ? "Open Customer Center" : "Open paywall"}
                  onPress={() => {
                    if (isPremium) {
                      void handleOpenCustomerCenter();
                      return;
                    }

                    void handlePresentPaywall();
                  }}
                />

                {hasConfiguredRevenueCat ? (
                  <SecondaryButton
                    disabled={isLoadingCustomerInfo}
                    label={"Restore purchases"}
                    onPress={() => {
                      void handleRestorePurchases();
                    }}
                  />
                ) : null}

                {hasConfiguredRevenueCat && isPremium ? (
                  <SecondaryButton
                    disabled={isLoadingCustomerInfo}
                    label={"Refresh customer info"}
                    onPress={() => {
                      void refreshCustomerInfo();
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

                {!session?.user ? (
                  <>
                    <PrimaryButton
                      disabled={isSigningInWithApple}
                      label={Platform.OS === "ios" ? "Continue with Apple" : "Sign in with Apple"}
                      onPress={() => {
                        void triggerAppleSignIn();
                      }}
                      tone={"inverted"}
                    />
                    <SecondaryButton
                      disabled={isSigningInWithGoogle}
                      label={"Continue with Google"}
                      onPress={() => {
                        void triggerGoogleSignIn();
                      }}
                    />
                  </>
                ) : (
                  <SecondaryButton
                    label={"Sign out"}
                    onPress={() => {
                      void signOut();
                      setWantsHostedLinksPanel(false);
                    }}
                    tone={"danger"}
                  />
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

              <SecondaryButton
                label={session?.user ? "Done" : "Maybe later"}
                onPress={() => setShowPremiumDetails(false)}
              />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: designTheme.background,
    flex: 1,
    paddingHorizontal: 24,
  },
  title: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 24,
    marginBottom: 20,
  },
  section: {
    marginBottom: 24,
  },
  sectionLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.medium,
    fontSize: 12,
    letterSpacing: 0.8,
    marginBottom: 10,
    textTransform: "uppercase",
  },
  group: {
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 18,
    borderWidth: 1,
    overflow: "hidden",
  },
  heroCard: {
    backgroundColor: designTheme.primary,
    borderRadius: 22,
    padding: 20,
  },
  heroCardActive: {
    backgroundColor: "#1d4ed8",
  },
  heroHeader: {
    flexDirection: "row",
    gap: 14,
    marginBottom: 18,
  },
  heroIconWrap: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.18)",
    borderRadius: 18,
    height: 56,
    justifyContent: "center",
    width: 56,
  },
  heroCopy: {
    flex: 1,
    gap: 4,
  },
  heroTitle: {
    color: designTheme.primaryForeground,
    fontFamily: designFonts.semibold,
    fontSize: 24,
  },
  heroDescription: {
    color: "rgba(255, 255, 255, 0.82)",
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  settingItem: {
    alignItems: "center",
    backgroundColor: designTheme.card,
    borderBottomColor: designTheme.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 14,
    minHeight: 72,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  settingIconWrap: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 999,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  settingCopy: {
    flex: 1,
    gap: 2,
  },
  settingLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  settingDescription: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  advancedToggleWrap: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  advancedToggleLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.medium,
    fontSize: 13,
  },
  advancedToggleChevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  editRow: {
    alignItems: "center",
    backgroundColor: designTheme.card,
    borderBottomColor: designTheme.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    minHeight: 72,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  deviceInput: {
    color: designTheme.foreground,
    flex: 1,
    fontFamily: designFonts.medium,
    fontSize: 15,
    minHeight: 24,
    paddingVertical: 0,
  },
  panel: {
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  advancedPanel: {
    marginTop: 12,
  },
  panelTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 18,
  },
  panelCopy: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  advancedField: {
    gap: 10,
  },
  advancedFieldCopy: {
    gap: 4,
  },
  advancedFieldLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  advancedFieldDescription: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  advancedInputWrap: {
    alignItems: "center",
    backgroundColor: designTheme.input,
    borderColor: designTheme.border,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 14,
  },
  advancedInput: {
    color: designTheme.foreground,
    flex: 1,
    fontFamily: designFonts.medium,
    fontSize: 15,
    minHeight: 24,
    paddingVertical: 0,
  },
  advancedInputSuffix: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.medium,
    fontSize: 13,
  },
  advancedActions: {
    gap: 10,
  },
  hostedInput: {
    backgroundColor: designTheme.input,
    borderColor: designTheme.border,
    borderRadius: 14,
    borderWidth: 1,
    color: designTheme.foreground,
    fontFamily: designFonts.regular,
    fontSize: 15,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  hostedList: {
    gap: 10,
  },
  hostedFileRow: {
    backgroundColor: designTheme.muted,
    borderRadius: 14,
    gap: 12,
    padding: 14,
  },
  hostedFileCopy: {
    gap: 4,
  },
  hostedFileName: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  hostedFileMeta: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
  },
  hostedActions: {
    flexDirection: "row",
    gap: 10,
  },
  footerNote: {
    backgroundColor: designTheme.muted,
    borderRadius: 16,
    marginTop: 8,
    padding: 16,
  },
  footerNoteText: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 12,
    lineHeight: 18,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: designTheme.primary,
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 16,
  },
  primaryButtonInverted: {
    backgroundColor: designTheme.card,
  },
  primaryButtonLabel: {
    color: designTheme.primaryForeground,
    fontFamily: designFonts.medium,
    fontSize: 16,
  },
  primaryButtonLabelInverted: {
    color: designTheme.primary,
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 14,
  },
  secondaryButtonLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  dangerButton: {
    borderColor: "rgba(220, 38, 38, 0.16)",
  },
  dangerButtonLabel: {
    color: designTheme.destructive,
  },
  inlineNotice: {
    backgroundColor: designTheme.muted,
    borderRadius: 14,
    gap: 4,
    padding: 12,
  },
  warningNotice: {
    backgroundColor: "rgba(217, 119, 6, 0.1)",
  },
  dangerNotice: {
    backgroundColor: "rgba(220, 38, 38, 0.08)",
  },
  inlineNoticeTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 14,
  },
  inlineNoticeDescription: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  modalOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(3, 2, 19, 0.42)",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: designTheme.card,
    borderRadius: 24,
    maxHeight: "88%",
    paddingTop: 20,
    width: "100%",
  },
  modalCloseButton: {
    alignItems: "center",
    alignSelf: "flex-end",
    height: 36,
    justifyContent: "center",
    marginRight: 16,
    width: 36,
  },
  modalContent: {
    gap: 14,
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  modalHeroIcon: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "rgba(37, 99, 235, 0.1)",
    borderRadius: 999,
    height: 64,
    justifyContent: "center",
    width: 64,
  },
  modalTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 28,
    textAlign: "center",
  },
  modalDescription: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  modalBenefits: {
    gap: 10,
    marginTop: 4,
  },
  benefitRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  benefitIconWrap: {
    alignItems: "center",
    backgroundColor: "rgba(22, 163, 74, 0.12)",
    borderRadius: 999,
    height: 20,
    justifyContent: "center",
    width: 20,
  },
  benefitLabel: {
    color: designTheme.foreground,
    flex: 1,
    fontFamily: designFonts.regular,
    fontSize: 14,
  },
  modalSection: {
    gap: 12,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  loadingLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
  },
  packageCard: {
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 6,
    padding: 16,
  },
  packageCardHighlighted: {
    backgroundColor: "rgba(37, 99, 235, 0.05)",
    borderColor: "rgba(37, 99, 235, 0.28)",
  },
  packageHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  packageTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 16,
  },
  packageBadge: {
    backgroundColor: designTheme.primary,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  packageBadgeLabel: {
    color: designTheme.primaryForeground,
    fontFamily: designFonts.medium,
    fontSize: 11,
  },
  packagePrice: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 22,
  },
  packageDescription: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.72,
  },
});
