import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import { File } from "expo-file-system";
import * as Linking from "expo-linking";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { PurchasesOfferings, PurchasesPackage } from "react-native-purchases";
import { ChevronRight, HelpCircle, Info, Link2, Shield, Smartphone, Zap } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useGoogleSignIn } from "@/hooks/use-google-sign-in";
import {
  useCompleteHostedUpload,
  useCreateHostedUpload,
  useDeleteHostedFile,
  useEntitlements,
  useHostedFiles,
  useSyncPurchase,
} from "@/hooks/queries";
import { useAppleSignIn } from "@/hooks/use-apple-sign-in";
import { signOut, useSession } from "@/lib/auth-client";
import { designFonts, designTheme } from "@/lib/design/theme";
import { pickTransferFiles } from "@/lib/file-transfer";
import {
  getCustomerInfo,
  getOfferings,
  isRevenueCatConfigured,
  loginPurchases,
  logoutPurchases,
  mapCustomerInfoToEntitlement,
  purchasePackage,
  restorePurchases,
} from "@/lib/purchases";
import { useAppStore, useAutoAcceptKnownDevices, useDeviceName } from "@/store";

function PrimaryButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Text style={styles.primaryButtonLabel}>{label}</Text>
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
      {action ?? (onPress ? <ChevronRight color={designTheme.mutedForeground} size={20} strokeWidth={2} /> : null)}
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

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const deviceName = useDeviceName();
  const autoAcceptKnownDevices = useAutoAcceptKnownDevices();
  const setDeviceName = useAppStore((state) => state.setDeviceName);
  const setAutoAcceptKnownDevices = useAppStore((state) => state.setAutoAcceptKnownDevices);
  const { data: session } = useSession();
  const entitlementsQuery = useEntitlements();
  const hostedFilesQuery = useHostedFiles(Boolean(session?.user && entitlementsQuery.data?.isPremium));
  const syncPurchaseMutation = useSyncPurchase();
  const createHostedUploadMutation = useCreateHostedUpload();
  const completeHostedUploadMutation = useCompleteHostedUpload();
  const deleteHostedFileMutation = useDeleteHostedFile();
  const { errorMessage: appleError, isSigningIn: isSigningInWithApple, triggerAppleSignIn } = useAppleSignIn();
  const { errorMessage: googleError, isSigningIn: isSigningInWithGoogle, triggerGoogleSignIn } = useGoogleSignIn();
  const [draftDeviceName, setDraftDeviceName] = useState(deviceName);
  const [isEditingDeviceName, setIsEditingDeviceName] = useState(false);
  const [showPremiumDetails, setShowPremiumDetails] = useState(false);
  const [wantsHostedLinksPanel, setWantsHostedLinksPanel] = useState(false);
  const [purchaseNotice, setPurchaseNotice] = useState<string | null>(null);
  const [hostedNotice, setHostedNotice] = useState<string | null>(null);
  const [hostedPasscode, setHostedPasscode] = useState("");
  const hasConfiguredRevenueCat = isRevenueCatConfigured();
  const isPremium = Boolean(entitlementsQuery.data?.isPremium);
  const showHostedLinksPanel = wantsHostedLinksPanel && isPremium;
  const sessionUserId = session?.user?.id ?? null;
  const offeringsQuery = useQuery<PurchasesOfferings | null>({
    queryKey: ["purchases", "offerings", sessionUserId],
    enabled: Boolean(sessionUserId && hasConfiguredRevenueCat && showPremiumDetails),
    queryFn: async () => {
      if (!sessionUserId) {
        return null;
      }

      await loginPurchases(sessionUserId);
      return getOfferings();
    },
  });

  async function refreshPremiumState() {
    if (!session?.user || !hasConfiguredRevenueCat) {
      return;
    }

    const customerInfo = await getCustomerInfo();
    if (!customerInfo) {
      return;
    }

    const mappedEntitlement = mapCustomerInfoToEntitlement(customerInfo);
    await syncPurchaseMutation.mutateAsync({
      ...mappedEntitlement,
      appUserId: session.user.id,
    });
  }

  async function handlePurchase(selectedPackage: PurchasesPackage) {
    if (!session?.user) {
      setPurchaseNotice("Sign in first so premium can be restored on another device later.");
      setShowPremiumDetails(true);
      return;
    }

    try {
      setPurchaseNotice(null);
      await purchasePackage(selectedPackage);
      await refreshPremiumState();
      setPurchaseNotice("Premium is active on this account.");
    } catch (error) {
      setPurchaseNotice(error instanceof Error ? error.message : "The purchase did not complete.");
    }
  }

  async function handleRestorePurchases() {
    if (!session?.user) {
      setShowPremiumDetails(true);
      setPurchaseNotice("Sign in first, then restore purchases.");
      return;
    }

    try {
      setPurchaseNotice(null);
      await restorePurchases();
      await refreshPremiumState();
      setPurchaseNotice("Purchases restored.");
    } catch (error) {
      setPurchaseNotice(error instanceof Error ? error.message : "Unable to restore purchases.");
    }
  }

  async function handleCreateHostedUpload() {
    if (!session?.user || !isPremium) {
      setShowPremiumDetails(true);
      setHostedNotice("Premium is required to create hosted links.");
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

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 24) + 12 }}
      showsVerticalScrollIndicator={false}
      style={[styles.root, { paddingTop: insets.top + 16 }]}
    >
      <Text style={styles.title}>Settings</Text>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Device</Text>
        <View style={styles.stack}>
          {isEditingDeviceName ? (
            <View style={styles.editRow}>
              <View style={styles.settingIconWrap}>
                <Smartphone color={designTheme.secondaryForeground} size={20} strokeWidth={1.9} />
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
              description={"Your device name shown to others"}
              icon={<Smartphone color={designTheme.secondaryForeground} size={20} strokeWidth={1.9} />}
              label={deviceName}
              onPress={() => {
                setDraftDeviceName(deviceName);
                setIsEditingDeviceName(true);
              }}
            />
          )}
        </View>
      </View>

      {!isPremium ? (
        <View style={styles.section}>
          <View style={styles.premiumCard}>
            <View style={styles.premiumHead}>
              <View style={styles.premiumIconWrap}>
                <Zap color={designTheme.primaryForeground} size={20} strokeWidth={2} />
              </View>
              <View style={styles.premiumCopy}>
                <Text style={styles.premiumTitle}>Upgrade to Premium</Text>
                <Text style={styles.premiumDescription}>Faster transfers & hosted links</Text>
              </View>
            </View>

            <View style={styles.bulletList}>
              <View style={styles.bulletRow}>
                <View style={styles.bulletDot} />
                <Text style={styles.bulletText}>Unlimited transfer speed</Text>
              </View>
              <View style={styles.bulletRow}>
                <View style={styles.bulletDot} />
                <Text style={styles.bulletText}>Share files via browser link</Text>
              </View>
              <View style={styles.bulletRow}>
                <View style={styles.bulletDot} />
                <Text style={styles.bulletText}>Up to 10 GB per file</Text>
              </View>
            </View>

            <PrimaryButton
              label={"Upgrade"}
              onPress={() => {
                setShowPremiumDetails((current) => !current);
                setPurchaseNotice(null);
              }}
            />
          </View>
        </View>
      ) : (
        <View style={styles.section}>
          <View style={styles.premiumCard}>
            <View style={styles.premiumHead}>
              <View style={[styles.premiumIconWrap, styles.premiumIconWrapActive]}>
                <Zap color={designTheme.primaryForeground} size={20} strokeWidth={2} />
              </View>
              <View style={styles.premiumCopy}>
                <Text style={styles.premiumTitle}>Premium active</Text>
                <Text style={styles.premiumDescription}>Fast transfers and hosted links are unlocked</Text>
              </View>
            </View>
            <PrimaryButton
              label={"Manage Premium"}
              onPress={() => {
                setShowPremiumDetails((current) => !current);
                setPurchaseNotice(null);
              }}
            />
          </View>
        </View>
      )}

      {showPremiumDetails ? (
        <View style={styles.inlinePanel}>
          {!session?.user ? (
            <View style={styles.stack}>
              <SecondaryButton
                disabled={isSigningInWithApple}
                label={Platform.OS === "ios" ? "Continue with Apple" : "Sign in with Apple"}
                onPress={() => {
                  void triggerAppleSignIn();
                }}
              />
              <SecondaryButton
                disabled={isSigningInWithGoogle}
                label={"Continue with Google"}
                onPress={() => {
                  void triggerGoogleSignIn();
                }}
              />
              <InlineNotice
                description={
                  "Free local transfers stay anonymous. Sign in only when you want premium or need to restore it later."
                }
                title={"No account before premium"}
              />
            </View>
          ) : (
            <View style={styles.stack}>
              <InlineNotice
                description={session.user.email ?? "Signed in"}
                title={isPremium ? "Premium account" : "Signed in"}
              />

              {hasConfiguredRevenueCat ? (
                offeringsQuery.isLoading ? (
                  <View style={styles.loadingRow}>
                    <ActivityIndicator color={designTheme.foreground} />
                    <Text style={styles.loadingLabel}>Loading premium plans...</Text>
                  </View>
                ) : offeringsQuery.data?.current?.availablePackages?.length ? (
                  offeringsQuery.data.current.availablePackages.map((selectedPackage) => (
                    <PrimaryButton
                      key={selectedPackage.identifier}
                      label={`Buy ${selectedPackage.product.title}`}
                      onPress={() => {
                        void handlePurchase(selectedPackage);
                      }}
                    />
                  ))
                ) : (
                  <InlineNotice
                    description={"RevenueCat is connected, but no current offering is available yet."}
                    title={"Premium plans not ready"}
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

              <SecondaryButton
                label={"Restore purchases"}
                onPress={() => {
                  void handleRestorePurchases();
                }}
              />
              <SecondaryButton
                label={"Sign out"}
                onPress={() => {
                  void signOut();
                  void logoutPurchases();
                  setWantsHostedLinksPanel(false);
                }}
                tone={"danger"}
              />
            </View>
          )}

          {purchaseNotice ? <InlineNotice description={purchaseNotice} title={"Premium status"} /> : null}
          {offeringsQuery.error ? (
            <InlineNotice
              description={
                offeringsQuery.error instanceof Error ? offeringsQuery.error.message : "Unable to load premium plans."
              }
              title={"Premium plans"}
              tone={"danger"}
            />
          ) : null}
          {appleError ? <InlineNotice description={appleError} title={"Apple sign-in"} tone={"danger"} /> : null}
          {googleError ? <InlineNotice description={googleError} title={"Google sign-in"} tone={"danger"} /> : null}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Transfers</Text>
        <View style={styles.stack}>
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
            icon={<Shield color={designTheme.secondaryForeground} size={20} strokeWidth={1.9} />}
            label={"Auto-accept from known devices"}
          />
          <SettingItem
            description={isPremium ? "Manage your shared links" : "Premium feature"}
            icon={<Link2 color={designTheme.secondaryForeground} size={20} strokeWidth={1.9} />}
            label={"Hosted links"}
            onPress={() => {
              if (!isPremium) {
                setShowPremiumDetails(true);
                setHostedNotice("Premium is required to create hosted links.");
                return;
              }

              setWantsHostedLinksPanel((current) => !current);
            }}
          />
        </View>
      </View>

      {showHostedLinksPanel ? (
        <View style={styles.inlinePanel}>
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

          <View style={styles.stack}>
            {hostedFilesQuery.data?.length ? (
              hostedFilesQuery.data.map((hostedFile) => (
                <View key={hostedFile.id} style={styles.hostedFileRow}>
                  <View style={styles.hostedFileCopy}>
                    <Text numberOfLines={1} style={styles.hostedFileName}>
                      {hostedFile.fileName}
                    </Text>
                    <Text style={styles.hostedFileMeta}>
                      Expires {new Date(hostedFile.expiresAt).toLocaleDateString()}
                      {hostedFile.requiresPasscode ? " · Passcode" : ""}
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
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Support</Text>
        <View style={styles.stack}>
          <SettingItem
            icon={<HelpCircle color={designTheme.secondaryForeground} size={20} strokeWidth={1.9} />}
            label={"Help & FAQ"}
            onPress={() => {
              Alert.alert(
                "Help & FAQ",
                "Free transfers work directly over nearby WiFi. Upgrade only when you want faster transfers or hosted browser links.",
              );
            }}
          />
          <SettingItem
            description={`Version ${Constants.expoConfig?.version ?? "1.0.0"}`}
            icon={<Info color={designTheme.secondaryForeground} size={20} strokeWidth={1.9} />}
            label={"About"}
            onPress={() => {
              Alert.alert("About", `File Transfers\nVersion ${Constants.expoConfig?.version ?? "1.0.0"}`);
            }}
          />
        </View>
      </View>

      <Pressable
        onPress={() => {
          void handleRestorePurchases();
        }}
        style={({ pressed }) => [styles.restoreButton, pressed ? styles.pressed : null]}
      >
        <Text style={styles.restoreButtonLabel}>Restore purchases</Text>
      </Pressable>
    </ScrollView>
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
    marginBottom: 24,
  },
  section: {
    marginBottom: 24,
  },
  sectionLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  stack: {
    gap: 12,
  },
  settingItem: {
    alignItems: "center",
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 16,
    padding: 16,
  },
  settingIconWrap: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 14,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  settingCopy: {
    flex: 1,
    gap: 2,
  },
  settingLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 16,
  },
  settingDescription: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  editRow: {
    alignItems: "center",
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 16,
    padding: 16,
  },
  deviceInput: {
    color: designTheme.foreground,
    flex: 1,
    fontFamily: designFonts.medium,
    fontSize: 16,
    minHeight: 24,
    paddingVertical: 0,
  },
  premiumCard: {
    backgroundColor: "rgba(79, 70, 229, 0.05)",
    borderColor: "rgba(79, 70, 229, 0.18)",
    borderRadius: 18,
    borderWidth: 1,
    padding: 20,
  },
  premiumHead: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 16,
  },
  premiumIconWrap: {
    alignItems: "center",
    backgroundColor: designTheme.primary,
    borderRadius: 14,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  premiumIconWrapActive: {
    backgroundColor: designTheme.primary,
  },
  premiumCopy: {
    flex: 1,
    gap: 2,
  },
  premiumTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 18,
  },
  premiumDescription: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
  },
  bulletList: {
    gap: 8,
    marginBottom: 16,
    marginLeft: 4,
  },
  bulletRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  bulletDot: {
    backgroundColor: designTheme.primary,
    borderRadius: 999,
    height: 4,
    width: 4,
  },
  bulletText: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: designTheme.primary,
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 16,
  },
  primaryButtonLabel: {
    color: designTheme.primaryForeground,
    fontFamily: designFonts.medium,
    fontSize: 16,
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 14,
  },
  secondaryButtonLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  dangerButton: {
    borderColor: "rgba(220, 38, 38, 0.18)",
  },
  dangerButtonLabel: {
    color: designTheme.destructive,
  },
  inlinePanel: {
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    marginBottom: 24,
    padding: 16,
  },
  inlineNotice: {
    backgroundColor: designTheme.muted,
    borderRadius: 14,
    gap: 4,
    padding: 12,
  },
  warningNotice: {
    backgroundColor: "rgba(245, 158, 11, 0.1)",
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
  hostedInput: {
    backgroundColor: "transparent",
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
  restoreButton: {
    alignItems: "center",
    marginTop: 8,
    paddingVertical: 12,
  },
  restoreButtonLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.72,
  },
});
