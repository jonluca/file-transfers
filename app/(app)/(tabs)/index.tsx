import { CameraView, useCameraPermissions } from "expo-camera";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { ArrowDown, ArrowUp, File, FileText, Film, ImageIcon, Music, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useEntitlements } from "@/hooks/queries";
import { designFonts, designTheme } from "@/lib/design/theme";
import {
  approveTransferRequest,
  formatBytes,
  parseDiscoveryQrPayload,
  pickTransferFiles,
  receiveTransfer,
  rejectTransferRequest,
  startHostingTransfer,
  startNearbyScan,
  stopHostingTransfer,
  type DiscoveryRecord,
  type SelectedTransferFile,
  type TransferHistoryEntry,
  type TransferProgress,
  type TransferSession,
} from "@/lib/file-transfer";
import { useAppStore, useDeviceName } from "@/store";

type TransferMode = "idle" | "sending" | "waiting" | "receiving" | "transferring";

function MimeIcon({ type }: { type: string }) {
  if (type.startsWith("image/")) {
    return <ImageIcon color={designTheme.secondaryForeground} size={24} strokeWidth={1.8} />;
  }

  if (type.startsWith("video/")) {
    return <Film color={designTheme.secondaryForeground} size={24} strokeWidth={1.8} />;
  }

  if (type.startsWith("audio/")) {
    return <Music color={designTheme.secondaryForeground} size={24} strokeWidth={1.8} />;
  }

  if (type.includes("pdf") || type.includes("document") || type.includes("text")) {
    return <FileText color={designTheme.secondaryForeground} size={24} strokeWidth={1.8} />;
  }

  return <File color={designTheme.secondaryForeground} size={24} strokeWidth={1.8} />;
}

function getTransferDetail(value: string | null | undefined, fallback: string) {
  return value ?? fallback;
}

function createHistoryEntryFromSendSession(session: TransferSession): TransferHistoryEntry {
  return {
    id: session.id,
    direction: "send",
    status: session.status === "idle" ? "failed" : session.status,
    deviceName: session.peerDeviceName ?? "Nearby device",
    fileCount: session.manifest.fileCount,
    totalBytes: session.manifest.totalBytes,
    bytesTransferred: session.progress.bytesTransferred,
    files: [],
    createdAt: session.manifest.createdAt,
    updatedAt: session.progress.updatedAt,
    detail: session.progress.detail,
  };
}

function createHistoryEntryFromReceive({
  record,
  progress,
  receivedFiles,
  status,
  detail,
}: {
  record: DiscoveryRecord;
  progress: TransferProgress;
  receivedFiles: TransferHistoryEntry["files"];
  status: TransferHistoryEntry["status"];
  detail: string | null;
}): TransferHistoryEntry {
  return {
    id: record.sessionId,
    direction: "receive",
    status,
    deviceName: record.deviceName,
    fileCount: record.fileCount,
    totalBytes: record.totalBytes,
    bytesTransferred: progress.bytesTransferred,
    files: receivedFiles,
    createdAt: record.advertisedAt,
    updatedAt: new Date().toISOString(),
    detail,
  };
}

function LargeActionCard({
  icon,
  label,
  primary = false,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionCard,
        primary ? styles.primaryActionCard : styles.secondaryActionCard,
        pressed ? styles.pressed : null,
      ]}
    >
      {icon}
      <Text style={[styles.actionCardLabel, primary ? styles.primaryActionLabel : null]}>{label}</Text>
    </Pressable>
  );
}

function HeaderButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={12}
      style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
    >
      <X color={designTheme.mutedForeground} size={24} strokeWidth={2} />
    </Pressable>
  );
}

function PrimaryButton({
  label,
  onPress,
  icon,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  icon?: React.ReactNode;
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
      {icon}
      <Text style={styles.primaryButtonLabel}>{label}</Text>
    </Pressable>
  );
}

function OutlineButton({ label, onPress, icon }: { label: string; onPress: () => void; icon?: React.ReactNode }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.outlineButton, pressed ? styles.pressed : null]}>
      {icon}
      <Text style={styles.outlineButtonLabel}>{label}</Text>
    </Pressable>
  );
}

function FileRow({ file, onRemove }: { file: SelectedTransferFile; onRemove?: () => void }) {
  return (
    <View style={styles.fileRow}>
      <View style={styles.fileIconWrap}>
        <MimeIcon type={file.mimeType} />
      </View>
      <View style={styles.fileCopy}>
        <Text numberOfLines={1} style={styles.fileName}>
          {file.name}
        </Text>
        <Text style={styles.fileMeta}>{formatBytes(file.sizeBytes)}</Text>
      </View>
      {onRemove ? (
        <Pressable
          onPress={onRemove}
          hitSlop={12}
          style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
        >
          <X color={designTheme.mutedForeground} size={20} strokeWidth={2} />
        </Pressable>
      ) : null}
    </View>
  );
}

function NearbyDeviceRow({ record, onPress }: { record: DiscoveryRecord; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.deviceRow, pressed ? styles.pressed : null]}>
      <View style={styles.deviceAvatar}>
        <Text style={styles.deviceAvatarLabel}>{record.deviceName.charAt(0).toUpperCase()}</Text>
      </View>
      <View style={styles.deviceCopy}>
        <Text style={styles.deviceName}>{record.deviceName}</Text>
        <Text style={styles.deviceMeta}>
          {record.fileCount} file{record.fileCount === 1 ? "" : "s"} · {formatBytes(record.totalBytes)}
        </Text>
      </View>
      <ArrowDown color={designTheme.primary} size={20} strokeWidth={2} />
    </Pressable>
  );
}

function WaitingPulse() {
  const [scale] = useState(() => new Animated.Value(1));
  const [opacity] = useState(() => new Animated.Value(0.38));

  useEffect(() => {
    const animation = Animated.loop(
      Animated.parallel([
        Animated.timing(scale, {
          toValue: 1.45,
          duration: 1500,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: 1500,
          useNativeDriver: true,
        }),
      ]),
    );

    animation.start();

    return () => {
      animation.stop();
      scale.setValue(1);
      opacity.setValue(0.38);
    };
  }, [opacity, scale]);

  return (
    <View style={styles.waitingPulseWrap}>
      <View style={styles.waitingPulseOuter}>
        <View style={styles.waitingPulseInner}>
          <ArrowUp color={designTheme.primary} size={48} strokeWidth={1.7} />
        </View>
      </View>
      <Animated.View
        pointerEvents={"none"}
        style={[
          styles.waitingPulseRing,
          {
            opacity,
            transform: [{ scale }],
          },
        ]}
      />
    </View>
  );
}

export default function TransferScreen() {
  const insets = useSafeAreaInsets();
  const deviceName = useDeviceName();
  const upsertRecentTransfer = useAppStore((state) => state.upsertRecentTransfer);
  const entitlementsQuery = useEntitlements();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [mode, setMode] = useState<TransferMode>("idle");
  const [stagedFiles, setStagedFiles] = useState<SelectedTransferFile[]>([]);
  const [activeSendSession, setActiveSendSession] = useState<TransferSession | null>(null);
  const [nearbyRecords, setNearbyRecords] = useState<DiscoveryRecord[]>([]);
  const [activeReceiveRecord, setActiveReceiveRecord] = useState<DiscoveryRecord | null>(null);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showQrScanner, setShowQrScanner] = useState(false);
  const [showQrCode, setShowQrCode] = useState(false);
  const completionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledFinalizedSessionIds = useRef(new Set<string>());
  const scannedQrRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void startNearbyScan({
      onUpdate(records) {
        if (cancelled) {
          return;
        }

        setNearbyRecords(records.filter((record) => record.sessionId !== activeSendSession?.id));
      },
      onError(error) {
        if (!cancelled) {
          setNotice(error.message);
        }
      },
    }).then((value) => {
      cleanup = value;
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [activeSendSession?.id]);

  useEffect(() => {
    return () => {
      if (completionTimeoutRef.current) {
        clearTimeout(completionTimeoutRef.current);
      }
    };
  }, []);

  const totalStagedBytes = useMemo(() => stagedFiles.reduce((sum, file) => sum + file.sizeBytes, 0), [stagedFiles]);

  function scheduleReset({ clearFiles, nextMode }: { clearFiles: boolean; nextMode: TransferMode }) {
    if (completionTimeoutRef.current) {
      clearTimeout(completionTimeoutRef.current);
    }

    completionTimeoutRef.current = setTimeout(() => {
      setActiveSendSession(null);
      setActiveReceiveRecord(null);
      setTransferProgress(null);
      setNotice(null);
      setShowQrCode(false);
      if (clearFiles) {
        setStagedFiles([]);
      }
      setMode(nextMode);
      completionTimeoutRef.current = null;
    }, 1000);
  }

  async function handlePickFiles(append = false) {
    const files = await pickTransferFiles();

    if (files.length === 0) {
      return;
    }

    setNotice(null);
    setShowQrCode(false);
    setShowQrScanner(false);
    setStagedFiles((current) => (append ? [...current, ...files] : files));
    setMode("sending");
  }

  function handleRemoveFile(index: number) {
    setStagedFiles((current) => {
      const nextFiles = current.filter((_, fileIndex) => fileIndex !== index);
      if (nextFiles.length === 0) {
        setMode("idle");
      }
      return nextFiles;
    });
  }

  async function handleCancel() {
    if (completionTimeoutRef.current) {
      clearTimeout(completionTimeoutRef.current);
      completionTimeoutRef.current = null;
    }

    if (activeSendSession) {
      await stopHostingTransfer(activeSendSession.id);
    }

    setActiveSendSession(null);
    setActiveReceiveRecord(null);
    setTransferProgress(null);
    setNotice(null);
    setShowQrScanner(false);
    setShowQrCode(false);
    setMode(stagedFiles.length > 0 ? "sending" : "idle");
  }

  async function handleStartWaiting() {
    if (stagedFiles.length === 0) {
      return;
    }

    setNotice(null);
    setTransferProgress(null);
    setMode("waiting");

    const session = await startHostingTransfer({
      files: stagedFiles,
      deviceName,
      isPremium: Boolean(entitlementsQuery.data?.isPremium),
      updateSession: (nextSession) => {
        setActiveSendSession({ ...nextSession });
        setTransferProgress(nextSession.progress);

        if (
          nextSession.status === "discoverable" ||
          nextSession.status === "waiting" ||
          nextSession.status === "connecting"
        ) {
          setMode("waiting");
          return;
        }

        if (nextSession.status === "transferring") {
          setMode("transferring");
          return;
        }

        if (
          ["completed", "failed", "canceled"].includes(nextSession.status) &&
          !handledFinalizedSessionIds.current.has(nextSession.id)
        ) {
          handledFinalizedSessionIds.current.add(nextSession.id);
          upsertRecentTransfer(createHistoryEntryFromSendSession(nextSession));
        }

        void stopHostingTransfer(nextSession.id);

        if (nextSession.status === "completed") {
          setNotice(nextSession.progress.detail ?? "Transfer complete.");
          setMode("transferring");
          scheduleReset({ clearFiles: true, nextMode: "idle" });
          return;
        }

        if (nextSession.status === "failed") {
          setNotice(nextSession.progress.detail ?? "The transfer could not be completed.");
          setActiveSendSession(null);
          setTransferProgress(null);
          setMode("sending");
          return;
        }

        setActiveSendSession(null);
        setTransferProgress(null);
        setMode("idle");
      },
    });

    setActiveSendSession(session);
  }

  async function handleApproveTransfer() {
    if (!activeSendSession) {
      return;
    }

    const didApprove = await approveTransferRequest(activeSendSession.id);
    if (!didApprove) {
      setNotice("That receiver is no longer waiting.");
    }
  }

  async function handleRejectTransfer() {
    if (!activeSendSession) {
      return;
    }

    await rejectTransferRequest(activeSendSession.id);
    setNotice(null);
  }

  async function beginReceiveTransfer(record: DiscoveryRecord) {
    setNotice(null);
    setShowQrScanner(false);
    setActiveReceiveRecord(record);
    setMode("transferring");

    const initialProgress: TransferProgress = {
      phase: "connecting",
      totalBytes: record.totalBytes,
      bytesTransferred: 0,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: "Connecting to the sender.",
      updatedAt: new Date().toISOString(),
    };

    setTransferProgress(initialProgress);

    try {
      const result = await receiveTransfer({
        record,
        deviceName,
        onProgress: setTransferProgress,
      });

      const finalProgress: TransferProgress = {
        phase: "completed",
        totalBytes: record.totalBytes,
        bytesTransferred: result.bytesTransferred,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: result.detail,
        updatedAt: new Date().toISOString(),
      };

      setTransferProgress(finalProgress);
      setNotice(getTransferDetail(result.detail, "Transfer complete."));
      upsertRecentTransfer(
        createHistoryEntryFromReceive({
          record,
          progress: finalProgress,
          receivedFiles: result.receivedFiles,
          status: "completed",
          detail: result.detail,
        }),
      );
      scheduleReset({ clearFiles: false, nextMode: "idle" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The transfer could not be completed.";
      const failedProgress: TransferProgress = {
        phase: "failed",
        totalBytes: record.totalBytes,
        bytesTransferred: transferProgress?.bytesTransferred ?? 0,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: message,
        updatedAt: new Date().toISOString(),
      };

      setTransferProgress(null);
      setActiveReceiveRecord(null);
      setMode("receiving");
      setNotice(message);
      upsertRecentTransfer(
        createHistoryEntryFromReceive({
          record,
          progress: failedProgress,
          receivedFiles: [],
          status: "failed",
          detail: message,
        }),
      );
    }
  }

  async function handleScanQrPress() {
    setNotice(null);

    if (!cameraPermission?.granted) {
      const permission = await requestCameraPermission();
      if (!permission.granted) {
        setNotice("Camera access is required to scan a QR code.");
        return;
      }
    }

    scannedQrRef.current = false;
    setShowQrScanner((current) => !current);
  }

  function handleQrCodeValue(value: string) {
    if (scannedQrRef.current) {
      return;
    }

    scannedQrRef.current = true;

    try {
      const record = parseDiscoveryQrPayload(value);
      void beginReceiveTransfer(record);
    } catch {
      setNotice("That QR code does not contain a valid transfer.");
      scannedQrRef.current = false;
    }
  }

  const currentProgress = transferProgress ?? activeSendSession?.progress ?? null;
  const progressPercent =
    currentProgress && currentProgress.totalBytes > 0
      ? Math.round((currentProgress.bytesTransferred / currentProgress.totalBytes) * 100)
      : 0;
  const currentTransferName = activeReceiveRecord?.deviceName ?? activeSendSession?.peerDeviceName ?? "Nearby device";
  const transferTitle =
    currentProgress?.phase === "waiting"
      ? "Waiting for approval"
      : progressPercent >= 100
        ? "Complete!"
        : "Transferring...";

  if (mode === "idle") {
    return (
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: 16 }]}>
        <View style={styles.idleWrap}>
          <LargeActionCard
            icon={<ArrowUp color={designTheme.primaryForeground} size={64} strokeWidth={1.5} />}
            label={"Send files"}
            primary
            onPress={() => {
              void handlePickFiles(false);
            }}
          />
          <LargeActionCard
            icon={<ArrowDown color={designTheme.foreground} size={64} strokeWidth={1.5} />}
            label={"Receive files"}
            onPress={() => {
              setNotice(null);
              setShowQrScanner(false);
              setMode("receiving");
            }}
          />
          {notice ? <Text style={styles.centerNotice}>{notice}</Text> : null}
        </View>
      </View>
    );
  }

  if (mode === "sending") {
    return (
      <View style={[styles.root, { paddingTop: insets.top + 16 }]}>
        <View style={styles.topBar}>
          <Text style={styles.sectionTitle}>Ready to send</Text>
          <HeaderButton
            onPress={() => {
              void handleCancel();
            }}
          />
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 24 }}
          style={styles.flex}
        >
          <View style={styles.stack}>
            {stagedFiles.map((file, index) => (
              <FileRow key={file.id} file={file} onRemove={() => handleRemoveFile(index)} />
            ))}
          </View>
          <Pressable
            onPress={() => {
              void handlePickFiles(true);
            }}
            style={({ pressed }) => [styles.addFilesButton, pressed ? styles.pressed : null]}
          >
            <Text style={styles.addFilesLabel}>Add more files</Text>
          </Pressable>
        </ScrollView>

        <View style={styles.footerArea}>
          <Text style={styles.footerMeta}>
            {stagedFiles.length} file{stagedFiles.length === 1 ? "" : "s"} · {formatBytes(totalStagedBytes)}
          </Text>
          <PrimaryButton label={"Continue"} onPress={() => void handleStartWaiting()} />
          {notice ? <Text style={styles.footerNotice}>{notice}</Text> : null}
        </View>
      </View>
    );
  }

  if (mode === "waiting") {
    if (activeSendSession?.awaitingApproval && activeSendSession.peerDeviceName) {
      return (
        <View style={[styles.root, { paddingTop: insets.top, paddingBottom: 24 }]}>
          <View style={styles.centerWrap}>
            <View style={styles.transferAvatar}>
              <Text style={styles.transferAvatarLabel}>{activeSendSession.peerDeviceName.charAt(0).toUpperCase()}</Text>
            </View>

            <Text style={styles.centerTitle}>{activeSendSession.peerDeviceName}</Text>
            <Text style={styles.centerSubtitle}>wants to receive your files</Text>

            <View style={styles.approvalActions}>
              <View style={styles.approvalAction}>
                <OutlineButton
                  label={"Decline"}
                  icon={<X color={designTheme.foreground} size={18} strokeWidth={2} />}
                  onPress={() => {
                    void handleRejectTransfer();
                  }}
                />
              </View>
              <View style={styles.approvalAction}>
                <PrimaryButton
                  label={"Send"}
                  icon={<ArrowUp color={designTheme.primaryForeground} size={18} strokeWidth={2} />}
                  onPress={() => {
                    void handleApproveTransfer();
                  }}
                />
              </View>
            </View>
          </View>
        </View>
      );
    }

    return (
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: 24 }]}>
        <View style={styles.centerWrap}>
          <WaitingPulse />
          <Text style={styles.centerTitle}>Waiting for receiver</Text>
          <Text style={styles.centerSubtitle}>Ask someone nearby to tap Receive</Text>
          <Text style={styles.centerMeta}>
            {stagedFiles.length} file{stagedFiles.length === 1 ? "" : "s"} · {formatBytes(totalStagedBytes)}
          </Text>
          <OutlineButton
            label={"Cancel"}
            onPress={() => {
              void handleCancel();
            }}
          />
          {activeSendSession?.qrPayload ? (
            <>
              <Pressable
                onPress={() => setShowQrCode((current) => !current)}
                style={({ pressed }) => [styles.textButton, pressed ? styles.pressed : null]}
              >
                <Text style={styles.textButtonLabel}>{showQrCode ? "Hide QR code" : "Show QR code"}</Text>
              </Pressable>
              {showQrCode ? (
                <View style={styles.qrCard}>
                  <QRCode value={activeSendSession.qrPayload} size={172} color={designTheme.foreground} />
                </View>
              ) : null}
            </>
          ) : null}
          {notice ? <Text style={styles.centerNotice}>{notice}</Text> : null}
        </View>
      </View>
    );
  }

  if (mode === "receiving") {
    return (
      <View style={[styles.root, { paddingTop: insets.top + 16 }]}>
        <View style={styles.topBar}>
          <Text style={styles.sectionTitle}>Nearby devices</Text>
          <HeaderButton
            onPress={() => {
              void handleCancel();
            }}
          />
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 24 }}
          style={styles.flex}
        >
          {nearbyRecords.length > 0 ? (
            <View style={styles.stack}>
              {nearbyRecords.map((record) => (
                <NearbyDeviceRow
                  key={`${record.sessionId}-${record.method}`}
                  record={record}
                  onPress={() => void beginReceiveTransfer(record)}
                />
              ))}
            </View>
          ) : (
            <View style={styles.emptySearchState}>
              <View style={styles.emptySearchIcon}>
                <ArrowDown color={designTheme.mutedForeground} size={32} strokeWidth={1.8} />
              </View>
              <Text style={styles.emptySearchLabel}>Looking for devices...</Text>
            </View>
          )}

          {showQrScanner ? (
            <View style={styles.scannerCard}>
              <Text style={styles.scannerTitle}>Scan a transfer QR code</Text>
              <View style={styles.cameraWrap}>
                <CameraView
                  style={styles.camera}
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={({ data }) => handleQrCodeValue(data)}
                />
              </View>
              <Text style={styles.scannerHint}>Point the camera at the sender&apos;s QR code.</Text>
            </View>
          ) : null}

          {notice ? <Text style={styles.receivingNotice}>{notice}</Text> : null}
        </ScrollView>

        <Pressable
          onPress={() => void handleScanQrPress()}
          style={({ pressed }) => [styles.bottomLink, pressed ? styles.pressed : null]}
        >
          <Text style={styles.bottomLinkLabel}>
            {showQrScanner ? "Hide QR scanner" : "Can't find device? Scan QR code"}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: 32 }]}>
      <View style={styles.transferWrap}>
        <View style={styles.transferAvatar}>
          <Text style={styles.transferAvatarLabel}>{currentTransferName.charAt(0).toUpperCase()}</Text>
        </View>
        <Text style={styles.transferTitle}>{transferTitle}</Text>
        <Text style={styles.transferSubtitle}>{currentTransferName}</Text>
        <View style={styles.progressWrap}>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${Math.max(0, Math.min(progressPercent, 100))}%`,
                  backgroundColor: progressPercent >= 100 ? designTheme.accent : designTheme.primary,
                },
              ]}
            />
          </View>
          <Text style={styles.progressLabel}>{progressPercent}%</Text>
        </View>
        {currentProgress?.currentFileName ? (
          <Text style={styles.transferFileName}>{currentProgress.currentFileName}</Text>
        ) : null}
        {currentProgress?.detail ? <Text style={styles.transferDetail}>{currentProgress.detail}</Text> : null}
        {notice ? <Text style={styles.centerNotice}>{notice}</Text> : null}
        {progressPercent < 100 && activeSendSession && activeSendSession.status !== "transferring" ? (
          <OutlineButton
            label={"Cancel"}
            onPress={() => {
              void handleCancel();
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: designTheme.background,
    flex: 1,
    paddingHorizontal: 24,
  },
  flex: {
    flex: 1,
  },
  stack: {
    gap: 12,
  },
  idleWrap: {
    alignItems: "center",
    flex: 1,
    gap: 24,
    justifyContent: "center",
  },
  actionCard: {
    alignItems: "center",
    aspectRatio: 1,
    borderRadius: 24,
    gap: 16,
    justifyContent: "center",
    maxWidth: 320,
    width: "100%",
  },
  primaryActionCard: {
    backgroundColor: designTheme.primary,
    shadowColor: designTheme.shadow,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.22,
    shadowRadius: 28,
    elevation: 8,
  },
  secondaryActionCard: {
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderWidth: 2,
  },
  actionCardLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 30,
  },
  primaryActionLabel: {
    color: designTheme.primaryForeground,
  },
  topBar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  sectionTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 24,
  },
  iconButton: {
    alignItems: "center",
    borderRadius: 999,
    justifyContent: "center",
    minHeight: 40,
    minWidth: 40,
  },
  fileRow: {
    alignItems: "center",
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 16,
    padding: 16,
  },
  fileIconWrap: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 14,
    height: 48,
    justifyContent: "center",
    width: 48,
  },
  fileCopy: {
    flex: 1,
    gap: 2,
  },
  fileName: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 16,
  },
  fileMeta: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
  },
  addFilesButton: {
    alignItems: "center",
    borderColor: designTheme.border,
    borderRadius: 18,
    borderStyle: "dashed",
    borderWidth: 2,
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  addFilesLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.medium,
    fontSize: 16,
  },
  footerArea: {
    borderTopColor: designTheme.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 14,
    paddingBottom: 12,
    paddingTop: 16,
  },
  footerMeta: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    textAlign: "center",
  },
  footerNotice: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: designTheme.primary,
    borderRadius: 18,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 56,
    paddingHorizontal: 18,
  },
  primaryButtonLabel: {
    color: designTheme.primaryForeground,
    fontFamily: designFonts.medium,
    fontSize: 20,
  },
  outlineButton: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 18,
  },
  outlineButtonLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 16,
  },
  disabled: {
    opacity: 0.5,
  },
  waitingPulseWrap: {
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 32,
  },
  waitingPulseOuter: {
    alignItems: "center",
    backgroundColor: "rgba(79, 70, 229, 0.08)",
    borderRadius: 64,
    height: 128,
    justifyContent: "center",
    width: 128,
  },
  waitingPulseInner: {
    alignItems: "center",
    backgroundColor: "rgba(79, 70, 229, 0.14)",
    borderRadius: 48,
    height: 96,
    justifyContent: "center",
    width: 96,
  },
  waitingPulseRing: {
    borderColor: "rgba(79, 70, 229, 0.24)",
    borderRadius: 64,
    borderWidth: 4,
    height: 128,
    position: "absolute",
    width: 128,
  },
  centerWrap: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  centerTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 32,
    marginBottom: 8,
  },
  centerSubtitle: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 16,
    marginBottom: 28,
    textAlign: "center",
  },
  centerMeta: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    marginBottom: 28,
  },
  approvalActions: {
    flexDirection: "row",
    gap: 16,
    marginTop: 8,
    width: "100%",
    maxWidth: 320,
  },
  approvalAction: {
    flex: 1,
  },
  centerNotice: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 12,
    textAlign: "center",
  },
  textButton: {
    marginTop: 24,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  textButtonLabel: {
    color: designTheme.primary,
    fontFamily: designFonts.medium,
    fontSize: 16,
  },
  qrCard: {
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 22,
    borderWidth: 1,
    marginTop: 12,
    padding: 18,
  },
  deviceRow: {
    alignItems: "center",
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 16,
    padding: 16,
  },
  deviceAvatar: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 999,
    height: 48,
    justifyContent: "center",
    width: 48,
  },
  deviceAvatarLabel: {
    color: designTheme.secondaryForeground,
    fontFamily: designFonts.semibold,
    fontSize: 20,
  },
  deviceCopy: {
    flex: 1,
    gap: 2,
  },
  deviceName: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 16,
  },
  deviceMeta: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
  },
  emptySearchState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 72,
  },
  emptySearchIcon: {
    alignItems: "center",
    backgroundColor: designTheme.muted,
    borderRadius: 999,
    height: 64,
    justifyContent: "center",
    marginBottom: 16,
    width: 64,
  },
  emptySearchLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 16,
  },
  scannerCard: {
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 22,
    borderWidth: 1,
    gap: 12,
    marginTop: 24,
    padding: 16,
  },
  scannerTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 18,
  },
  cameraWrap: {
    borderRadius: 18,
    overflow: "hidden",
  },
  camera: {
    aspectRatio: 1,
    backgroundColor: "#000000",
    width: "100%",
  },
  scannerHint: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  receivingNotice: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 20,
    textAlign: "center",
  },
  bottomLink: {
    alignItems: "center",
    paddingVertical: 16,
  },
  bottomLinkLabel: {
    color: designTheme.primary,
    fontFamily: designFonts.medium,
    fontSize: 16,
    textAlign: "center",
  },
  transferWrap: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  transferAvatar: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 999,
    height: 80,
    justifyContent: "center",
    marginBottom: 24,
    width: 80,
  },
  transferAvatarLabel: {
    color: designTheme.secondaryForeground,
    fontFamily: designFonts.semibold,
    fontSize: 32,
  },
  transferTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 32,
    marginBottom: 8,
  },
  transferSubtitle: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 16,
    marginBottom: 32,
  },
  progressWrap: {
    maxWidth: 320,
    width: "100%",
  },
  progressTrack: {
    backgroundColor: designTheme.muted,
    borderRadius: 999,
    height: 8,
    marginBottom: 8,
    overflow: "hidden",
  },
  progressFill: {
    borderRadius: 999,
    height: "100%",
  },
  progressLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    textAlign: "center",
  },
  transferFileName: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 18,
    textAlign: "center",
  },
  transferDetail: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
    textAlign: "center",
  },
  pressed: {
    opacity: 0.72,
  },
});
