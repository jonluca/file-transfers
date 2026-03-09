import { CameraView, useCameraPermissions } from "expo-camera";
import { Stack, router } from "expo-router";
import { QrCode, X } from "lucide-react-native";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { designFonts, designTheme } from "@/lib/design/theme";
import { parseDiscoveryQrPayload } from "@/lib/file-transfer";
import { useAppStore, useDeviceName } from "@/store";

function ActionButton({
  icon,
  label,
  onPress,
  secondary = false,
}: {
  icon?: React.ReactNode;
  label: string;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        secondary ? styles.secondaryActionButton : styles.primaryActionButton,
        pressed ? styles.pressed : null,
      ]}
    >
      {icon}
      <Text style={[styles.actionButtonLabel, secondary ? styles.secondaryActionButtonLabel : null]}>{label}</Text>
    </Pressable>
  );
}

export default function ScanReceiverQrScreen() {
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [notice, setNotice] = useState<string | null>(null);
  const deviceName = useDeviceName();
  const setPendingScannedReceiver = useAppStore((state) => state.setPendingScannedReceiver);
  const requestedPermissionRef = useRef(false);
  const scannedQrRef = useRef(false);
  const unlockScanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasCameraAccess = Boolean(cameraPermission?.granted);
  const canRequestPermission = cameraPermission?.canAskAgain !== false;

  useEffect(() => {
    if (hasCameraAccess || requestedPermissionRef.current || !canRequestPermission) {
      return;
    }

    requestedPermissionRef.current = true;
    void requestCameraPermission();
  }, [canRequestPermission, hasCameraAccess, requestCameraPermission]);

  useEffect(() => {
    if (hasCameraAccess) {
      setNotice(null);
    }
  }, [hasCameraAccess]);

  useEffect(() => {
    return () => {
      if (unlockScanTimeoutRef.current) {
        clearTimeout(unlockScanTimeoutRef.current);
      }
    };
  }, []);

  function handleInvalidQrScan() {
    setNotice("That QR code does not contain a valid receiver.");

    if (unlockScanTimeoutRef.current) {
      clearTimeout(unlockScanTimeoutRef.current);
    }

    unlockScanTimeoutRef.current = setTimeout(() => {
      scannedQrRef.current = false;
      unlockScanTimeoutRef.current = null;
    }, 1200);
  }

  function handleBarcodeScanned(data: string) {
    if (!isFocused || scannedQrRef.current) {
      return;
    }

    scannedQrRef.current = true;

    try {
      const record = parseDiscoveryQrPayload(data, {
        deviceName,
      });
      setNotice(null);
      setPendingScannedReceiver(record);
      router.back();
    } catch {
      handleInvalidQrScan();
    }
  }

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: "Scan Receiver QR" }} />

      <View style={[styles.content, { paddingBottom: insets.bottom + 24, paddingTop: 24 }]}>
        <View style={styles.headerCard}>
          <View style={styles.headerIcon}>
            <QrCode color={designTheme.primary} size={24} strokeWidth={2} />
          </View>
          <Text style={styles.title}>Point the camera at the receiver&apos;s QR code.</Text>
          <Text style={styles.subtitle}>
            The app will return to the transfer screen as soon as it finds a valid receiver.
          </Text>
        </View>

        <View style={styles.cameraCard}>
          {hasCameraAccess ? (
            <CameraView
              style={styles.camera}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={isFocused ? ({ data }) => handleBarcodeScanned(data) : undefined}
            />
          ) : (
            <View style={styles.permissionState}>
              <ActivityIndicator color={designTheme.primary} size={"small"} />
              <Text style={styles.permissionTitle}>Camera access is required to scan a QR code.</Text>
              <Text style={styles.permissionBody}>
                {canRequestPermission
                  ? "Allow camera access to continue."
                  : "Enable camera access in Settings, then reopen the scanner."}
              </Text>
            </View>
          )}
        </View>

        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        <View style={styles.actions}>
          {!hasCameraAccess && canRequestPermission ? (
            <ActionButton label={"Allow camera"} onPress={() => void requestCameraPermission()} />
          ) : null}
          <ActionButton
            icon={<X color={designTheme.foreground} size={16} strokeWidth={2} />}
            label={"Cancel"}
            onPress={() => router.back()}
            secondary
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: designTheme.background,
    flex: 1,
  },
  content: {
    flex: 1,
    gap: 20,
    paddingHorizontal: 24,
  },
  headerCard: {
    alignItems: "center",
    backgroundColor: designTheme.muted,
    borderColor: designTheme.border,
    borderRadius: 24,
    borderWidth: 1,
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 20,
  },
  headerIcon: {
    alignItems: "center",
    backgroundColor: designTheme.card,
    borderRadius: 999,
    height: 48,
    justifyContent: "center",
    width: 48,
  },
  title: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 22,
    textAlign: "center",
  },
  subtitle: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
  },
  cameraCard: {
    backgroundColor: designTheme.muted,
    borderColor: designTheme.border,
    borderRadius: 28,
    borderWidth: 1,
    flex: 1,
    minHeight: 320,
    overflow: "hidden",
  },
  camera: {
    backgroundColor: "#000000",
    flex: 1,
  },
  permissionState: {
    alignItems: "center",
    flex: 1,
    gap: 10,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  permissionTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 16,
    textAlign: "center",
  },
  permissionBody: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
  },
  notice: {
    color: designTheme.destructive,
    fontFamily: designFonts.medium,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  actions: {
    gap: 12,
  },
  actionButton: {
    alignItems: "center",
    borderRadius: 16,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 18,
  },
  primaryActionButton: {
    backgroundColor: designTheme.primary,
  },
  secondaryActionButton: {
    backgroundColor: designTheme.secondary,
  },
  actionButtonLabel: {
    color: designTheme.primaryForeground,
    fontFamily: designFonts.medium,
    fontSize: 16,
  },
  secondaryActionButtonLabel: {
    color: designTheme.foreground,
  },
  pressed: {
    opacity: 0.85,
  },
});
