import { CameraView, useCameraPermissions } from "expo-camera";
import { Stack, router } from "expo-router";
import { QrCode, X } from "lucide-react-native";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "@/lib/cn";
import { designFonts, designTheme } from "@/lib/design/theme";
import { parseDiscoveryQrPayload } from "@/lib/file-transfer";
import { useAppStore, useDeviceName } from "@/store";

const fontStyles = {
  medium: { fontFamily: designFonts.medium },
  regular: { fontFamily: designFonts.regular },
  semibold: { fontFamily: designFonts.semibold },
} as const;

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
      className={cn(
        "min-h-[52px] flex-row items-center justify-center gap-2 rounded-2xl px-[18px]",
        secondary ? "bg-[#f3f4f6]" : "bg-[#2563eb]",
      )}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      {icon}
      <Text className={cn("text-base", secondary ? "text-[#030213]" : "text-white")} style={fontStyles.medium}>
        {label}
      </Text>
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
    <View className={"flex-1 bg-white"}>
      <Stack.Screen options={{ title: "Scan Receiver QR" }} />

      <View className={"flex-1 gap-5 px-6"} style={{ paddingBottom: insets.bottom + 24, paddingTop: 24 }}>
        <View className={"items-center gap-2.5 rounded-[24px] border border-[#e5e7eb] bg-[#f9fafb] px-5 py-5"}>
          <View className={"h-12 w-12 items-center justify-center rounded-full bg-white"}>
            <QrCode color={designTheme.primary} size={24} strokeWidth={2} />
          </View>
          <Text className={"text-center text-[22px] text-[#030213]"} style={fontStyles.semibold}>
            Point the camera at the receiver&apos;s QR code.
          </Text>
          <Text className={"text-center text-sm leading-[21px] text-[#6b7280]"} style={fontStyles.regular}>
            The app will return to the transfer screen as soon as it finds a valid receiver.
          </Text>
        </View>

        <View className={"min-h-[320px] flex-1 overflow-hidden rounded-[28px] border border-[#e5e7eb] bg-[#f9fafb]"}>
          {hasCameraAccess ? (
            <CameraView
              style={{ backgroundColor: "#000000", flex: 1 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={isFocused ? ({ data }) => handleBarcodeScanned(data) : undefined}
            />
          ) : (
            <View className={"flex-1 items-center justify-center gap-2.5 px-6"}>
              <ActivityIndicator color={designTheme.primary} size={"small"} />
              <Text className={"text-center text-base text-[#030213]"} style={fontStyles.medium}>
                Camera access is required to scan a QR code.
              </Text>
              <Text className={"text-center text-sm leading-[21px] text-[#6b7280]"} style={fontStyles.regular}>
                {canRequestPermission
                  ? "Allow camera access to continue."
                  : "Enable camera access in Settings, then reopen the scanner."}
              </Text>
            </View>
          )}
        </View>

        {notice ? (
          <Text className={"text-center text-sm leading-5 text-[#dc2626]"} style={fontStyles.medium}>
            {notice}
          </Text>
        ) : null}

        <View className={"gap-3"}>
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
