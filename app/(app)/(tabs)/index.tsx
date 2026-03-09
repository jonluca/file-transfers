import { router } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import * as Burnt from "burnt";
import React, { startTransition, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  type StyleProp,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import QRCode from "react-native-qrcode-svg";
import {
  Download,
  File,
  FileText,
  Film,
  Globe,
  ImageIcon,
  Music,
  QrCode,
  Smartphone,
  Upload,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { InlineNotice } from "@/components/ui";
import { usePremiumAccess } from "@/hooks/use-premium-access";
import { designFonts, designTheme } from "@/lib/design/theme";
import {
  acceptIncomingTransferOffer,
  assertSelectedFilesTransferAllowed,
  declineIncomingTransferOffer,
  formatBytes,
  isTransferSizeLimitError,
  startHttpShareSession,
  pickTransferFiles,
  startReceivingAvailability,
  startSendingTransfer,
  startNearbyScan,
  stopHttpShareSession,
  stopReceivingAvailability,
  stopSendingTransfer,
  type DiscoveryRecord,
  type HttpShareSession,
  type ReceiveSession,
  type SelectedTransferFile,
  type TransferSizeLimitNotice,
  type TransferManifestFile,
  type TransferHistoryEntry,
  type TransferProgress,
  type TransferSession,
} from "@/lib/file-transfer";
import { noteTransferScreenRender } from "@/lib/file-transfer/transfer-perf";
import { useAppStore, useDeviceName, useServiceInstanceId } from "@/store";

type TransferMode = "idle" | "sending" | "waiting" | "receiving" | "transferring" | "sharing";

const TRANSFER_SCREEN_DEBUG_PREFIX = "[TransferScreen]";

function showBanner({ description, title }: TransferSizeLimitNotice) {
  void Burnt.toast({
    duration: 5,
    from: "top",
    haptic: "error",
    message: description,
    preset: "error",
    title,
  });
}

async function pickTransferFilesSafely() {
  try {
    return {
      error: null,
      files: await pickTransferFiles(),
    };
  } catch (error) {
    return {
      error,
      files: null,
    };
  }
}

function getSelectionValidationError(files: SelectedTransferFile[], isPremium: boolean) {
  try {
    assertSelectedFilesTransferAllowed(files, isPremium, "send");
    return null;
  } catch (error) {
    return error;
  }
}

function logTransferScreenDebug(message: string, details?: Record<string, unknown>) {
  if (!__DEV__) {
    return;
  }

  if (details) {
    console.debug(`${TRANSFER_SCREEN_DEBUG_PREFIX} ${message}`, details);
    return;
  }

  console.debug(`${TRANSFER_SCREEN_DEBUG_PREFIX} ${message}`);
}

function getDebugSessionId(sessionId: string | null | undefined) {
  return sessionId?.slice(0, 8) ?? null;
}

function getDebugErrorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    error: String(error),
  };
}

function MimeIcon({ type }: { type: string }) {
  if (type.startsWith("image/")) {
    return <ImageIcon color={designTheme.secondaryForeground} size={22} strokeWidth={1.8} />;
  }

  if (type.startsWith("video/")) {
    return <Film color={designTheme.secondaryForeground} size={22} strokeWidth={1.8} />;
  }

  if (type.startsWith("audio/")) {
    return <Music color={designTheme.secondaryForeground} size={22} strokeWidth={1.8} />;
  }

  if (type.includes("pdf") || type.includes("document") || type.includes("text")) {
    return <FileText color={designTheme.secondaryForeground} size={22} strokeWidth={1.8} />;
  }

  return <File color={designTheme.secondaryForeground} size={22} strokeWidth={1.8} />;
}

function getTransferDetail(value: string | null | undefined, fallback: string) {
  return value ?? fallback;
}

function formatTransferSpeed(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return "Calculating...";
  }

  return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}

function formatTransferEta(progress: TransferProgress) {
  const remainingBytes = progress.totalBytes - progress.bytesTransferred;
  if (remainingBytes <= 0) {
    return "Almost done";
  }

  if (!Number.isFinite(progress.speedBytesPerSecond) || progress.speedBytesPerSecond <= 0) {
    return "Calculating...";
  }

  const totalSeconds = Math.max(1, Math.ceil(remainingBytes / progress.speedBytesPerSecond));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
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

function createHistoryEntryFromReceiveSession(session: ReceiveSession): TransferHistoryEntry {
  const offer = session.incomingOffer;

  return {
    id: session.id,
    direction: "receive",
    status: session.status === "idle" ? "failed" : session.status,
    deviceName: offer?.senderDeviceName ?? session.peerDeviceName ?? "Nearby device",
    fileCount: offer?.fileCount ?? 0,
    totalBytes: offer?.totalBytes ?? 0,
    bytesTransferred: session.progress.bytesTransferred,
    files: session.receivedFiles,
    createdAt: offer?.createdAt ?? session.progress.updatedAt,
    updatedAt: session.progress.updatedAt,
    detail: session.progress.detail,
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
  style,
  labelStyle,
}: {
  label: string;
  onPress: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        style,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      {icon}
      <Text style={[styles.primaryButtonLabel, labelStyle]}>{label}</Text>
    </Pressable>
  );
}

function OutlineButton({
  label,
  onPress,
  icon,
  style,
  labelStyle,
}: {
  label: string;
  onPress: () => void;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.outlineButton, style, pressed ? styles.pressed : null]}
    >
      {icon}
      <Text style={[styles.outlineButtonLabel, labelStyle]}>{label}</Text>
    </Pressable>
  );
}

function FileRow({
  file,
  onRemove,
}: {
  file: Pick<SelectedTransferFile, "name" | "mimeType" | "sizeBytes"> | TransferManifestFile;
  onRemove?: () => void;
}) {
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
        <Smartphone color={designTheme.secondaryForeground} size={18} strokeWidth={2} />
      </View>
      <View style={styles.deviceCopy}>
        <Text style={styles.deviceName}>{record.deviceName}</Text>
        <Text style={styles.deviceMeta}>Ready to receive files</Text>
      </View>
      <Upload color={designTheme.primary} size={18} strokeWidth={2} />
    </Pressable>
  );
}

function WaitingPulse({ tone = "primary" }: { tone?: "primary" | "neutral" }) {
  return (
    <View style={styles.waitingPulseWrap}>
      <View style={[styles.waitingPulseOuter, tone === "neutral" ? styles.waitingPulseOuterNeutral : null]}>
        <ActivityIndicator
          color={tone === "primary" ? designTheme.primary : designTheme.mutedForeground}
          size={"large"}
        />
      </View>
    </View>
  );
}

export default function TransferScreen() {
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  // View-root tab states need the raw safe-area inset because NativeTabs disables automatic iOS content insets.
  const screenTopPadding = insets.top + 16;
  const compactBottomPadding = insets.bottom + 16;
  const regularBottomPadding = insets.bottom + 24;
  const roomyBottomPadding = insets.bottom + 32;
  const footerBottomPadding = insets.bottom + 12;
  const bottomLinkPadding = insets.bottom + 16;
  const deviceName = useDeviceName();
  const serviceInstanceId = useServiceInstanceId();
  const premiumAccess = usePremiumAccess();
  const upsertRecentTransfer = useAppStore((state) => state.upsertRecentTransfer);
  const [mode, setMode] = useState<TransferMode>("idle");
  const [stagedFiles, setStagedFiles] = useState<SelectedTransferFile[]>([]);
  const [activeSendSession, setActiveSendSession] = useState<TransferSession | null>(null);
  const [activeReceiveSession, setActiveReceiveSession] = useState<ReceiveSession | null>(null);
  const [activeHttpShareSession, setActiveHttpShareSession] = useState<HttpShareSession | null>(null);
  const [nearbyRecords, setNearbyRecords] = useState<DiscoveryRecord[]>([]);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<TransferSizeLimitNotice | null>(null);
  const [showQrCode, setShowQrCode] = useState(false);
  const completionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledFinalizedSendSessionIds = useRef(new Set<string>());
  const handledFinalizedReceiveSessionIds = useRef(new Set<string>());
  const stoppingHttpShareSessionIdRef = useRef<string | null>(null);
  const isStartingReceiveAvailabilityRef = useRef(false);
  const receiveAvailabilityKeyRef = useRef<string | null>(null);
  const pendingScannedReceiver = useAppStore((state) => state.pendingScannedReceiver);
  const setPendingScannedReceiver = useAppStore((state) => state.setPendingScannedReceiver);
  const ensureReceiveAvailabilityRef = useRef<
    (options?: { preserveNotice?: boolean; showReceivingScreen?: boolean; surfaceErrors?: boolean }) => Promise<boolean>
  >(async () => false);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void startNearbyScan({
      onUpdate(records) {
        if (cancelled) {
          return;
        }

        setNearbyRecords(records.filter((record) => record.sessionId !== activeReceiveSession?.id));
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
  }, [activeReceiveSession?.id]);

  useEffect(() => {
    return () => {
      if (completionTimeoutRef.current) {
        clearTimeout(completionTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (activeSendSession?.id) {
      noteTransferScreenRender(activeSendSession.id, "send");
      return;
    }

    if (activeReceiveSession?.id) {
      noteTransferScreenRender(activeReceiveSession.id, "receive");
    }
  });

  useEffect(() => {
    const sessionId = activeReceiveSession?.id;
    return () => {
      if (sessionId) {
        void stopReceivingAvailability(sessionId);
      }
    };
  }, [activeReceiveSession?.id]);

  const stopBrowserShareSession = useEffectEvent(
    async (
      options: {
        sessionId?: string | null;
        nextMode?: TransferMode;
        noticeMessage?: string | null;
      } = {},
    ) => {
      const sessionId = options.sessionId ?? activeHttpShareSession?.id ?? null;
      const nextMode = options.nextMode ?? (stagedFiles.length > 0 ? "sending" : "idle");
      const noticeMessage = options.noticeMessage;

      if (!sessionId) {
        return;
      }

      if (stoppingHttpShareSessionIdRef.current === sessionId) {
        return;
      }

      stoppingHttpShareSessionIdRef.current = sessionId;

      let stopError: unknown = null;
      await stopHttpShareSession(sessionId).catch((error) => {
        stopError = error;
      });

      const stoppingSessionId = stoppingHttpShareSessionIdRef.current;
      if (stoppingSessionId === sessionId) {
        stoppingHttpShareSessionIdRef.current = null;
      }

      setActiveHttpShareSession((current) => (current?.id === sessionId ? null : current));
      setMode((current) => (current === "sharing" ? nextMode : current));
      setShowQrCode(false);

      if (noticeMessage !== undefined) {
        setNotice(noticeMessage);
      }

      if (stopError instanceof Error) {
        setNotice(stopError.message);
      }
    },
  );

  const handleHttpShareSessionUpdate = useEffectEvent((nextSession: HttpShareSession) => {
    setActiveHttpShareSession(nextSession);

    if (nextSession.status === "sharing") {
      setMode("sharing");
      return;
    }

    setActiveHttpShareSession(null);

    if (nextSession.status === "failed") {
      setNotice(getTransferDetail(nextSession.detail, "Browser sharing stopped unexpectedly."));
    }

    setMode((current) => (current === "sharing" ? (stagedFiles.length > 0 ? "sending" : "idle") : current));
  });

  function scheduleReset({ clearFiles, nextMode }: { clearFiles: boolean; nextMode: TransferMode }) {
    if (completionTimeoutRef.current) {
      clearTimeout(completionTimeoutRef.current);
    }

    completionTimeoutRef.current = setTimeout(() => {
      setActiveSendSession(null);
      setActiveReceiveSession(null);
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

  function handleReceiveSessionUpdate(nextSession: ReceiveSession) {
    setActiveReceiveSession(nextSession);
    if (nextSession.status === "discoverable") {
      if (mode === "receiving") {
        setTransferProgress(nextSession.progress);
      }
      return;
    }

    setTransferProgress(nextSession.progress);

    if (nextSession.status === "waiting") {
      setMode("receiving");
      return;
    }

    if (nextSession.status === "connecting" || nextSession.status === "transferring") {
      setMode("transferring");
      return;
    }

    if (
      ["completed", "failed", "canceled"].includes(nextSession.status) &&
      !handledFinalizedReceiveSessionIds.current.has(nextSession.id)
    ) {
      handledFinalizedReceiveSessionIds.current.add(nextSession.id);
      startTransition(() => {
        upsertRecentTransfer(createHistoryEntryFromReceiveSession(nextSession));
      });
    }

    receiveAvailabilityKeyRef.current = null;
    setActiveReceiveSession(null);

    if (nextSession.status === "completed") {
      startTransition(() => {
        setNotice(getTransferDetail(nextSession.progress.detail, "Transfer complete."));
      });
      setMode("transferring");
      scheduleReset({ clearFiles: false, nextMode: "idle" });
      void (async () => {
        await stopReceivingAvailability(nextSession.id).catch(() => {});
        await ensureReceiveAvailabilityRef.current({
          preserveNotice: true,
          showReceivingScreen: false,
          surfaceErrors: false,
        });
      })();
      return;
    }

    if (nextSession.status === "failed") {
      setTransferProgress(null);
      const detail = getTransferDetail(nextSession.progress.detail, "The transfer could not be completed.");
      const shouldSurfaceError =
        !activeHttpShareSession && detail !== "Local transfer stopped because browser sharing started.";

      if (shouldSurfaceError) {
        startTransition(() => {
          setNotice(detail);
        });
      }

      setMode((current) => {
        if (current === "receiving") {
          return "receiving";
        }

        if (current === "transferring" && !activeSendSession) {
          return "idle";
        }

        return current;
      });
      void (async () => {
        await stopReceivingAvailability(nextSession.id).catch(() => {});
        if (!activeHttpShareSession) {
          await ensureReceiveAvailabilityRef.current({
            preserveNotice: true,
            showReceivingScreen: mode === "receiving",
            surfaceErrors: false,
          });
        }
      })();
      return;
    }

    setTransferProgress(null);
    setMode((current) => {
      if (current === "receiving") {
        return "idle";
      }

      if (current === "transferring" && !activeSendSession) {
        return "idle";
      }

      return current;
    });
    void (async () => {
      await stopReceivingAvailability(nextSession.id).catch(() => {});
      if (!activeHttpShareSession) {
        await ensureReceiveAvailabilityRef.current({
          preserveNotice: true,
          showReceivingScreen: false,
          surfaceErrors: false,
        });
      }
    })();
  }

  const ensureReceiveAvailability = useEffectEvent(
    async ({
      preserveNotice = true,
      showReceivingScreen = false,
      surfaceErrors = false,
    }: {
      preserveNotice?: boolean;
      showReceivingScreen?: boolean;
      surfaceErrors?: boolean;
    } = {}) => {
      if (activeHttpShareSession) {
        return false;
      }

      const nextReceiveAvailabilityKey = `${deviceName}|${serviceInstanceId}|${premiumAccess.isPremium ? "premium" : "free"}`;
      const hasUsableSession =
        Boolean(activeReceiveSession) &&
        !["completed", "failed", "canceled"].includes(activeReceiveSession?.status ?? "") &&
        receiveAvailabilityKeyRef.current === nextReceiveAvailabilityKey;

      if (hasUsableSession) {
        if (showReceivingScreen && activeReceiveSession) {
          setNotice(null);
          setTransferProgress(activeReceiveSession.progress);
          setShowQrCode(false);
          setMode("receiving");
        }
        return true;
      }

      if (isStartingReceiveAvailabilityRef.current) {
        return false;
      }

      isStartingReceiveAvailabilityRef.current = true;
      if (!preserveNotice) {
        setNotice(null);
      }

      if (showReceivingScreen) {
        setTransferProgress(null);
        setShowQrCode(false);
        setMode("receiving");
      }

      if (activeReceiveSession) {
        await stopReceivingAvailability(activeReceiveSession.id).catch(() => {});
        setActiveReceiveSession(null);
      }

      const session = await startReceivingAvailability({
        deviceName,
        isPremium: premiumAccess.isPremium,
        serviceInstanceId,
        updateSession: handleReceiveSessionUpdate,
      }).catch((error) => {
        receiveAvailabilityKeyRef.current = null;
        setActiveReceiveSession(null);
        if (showReceivingScreen) {
          setTransferProgress(null);
          setMode("idle");
        }
        if (surfaceErrors) {
          setNotice(error instanceof Error ? error.message : "Unable to get ready to receive.");
        }
        return null;
      });

      isStartingReceiveAvailabilityRef.current = false;

      if (!session) {
        return false;
      }

      receiveAvailabilityKeyRef.current = nextReceiveAvailabilityKey;
      setActiveReceiveSession(session);
      if (showReceivingScreen) {
        setTransferProgress(session.progress);
      }
      return true;
    },
  );

  useEffect(() => {
    ensureReceiveAvailabilityRef.current = ensureReceiveAvailability;
  });

  function surfaceSelectionError(error: TransferSizeLimitNotice) {
    setNotice(null);
    setSelectionError(error);
    showBanner(error);
  }

  useEffect(() => {
    if (activeHttpShareSession) {
      return;
    }

    const nextReceiveAvailabilityKey = `${deviceName}|${serviceInstanceId}|${premiumAccess.isPremium ? "premium" : "free"}`;
    const hasUsableSession =
      Boolean(activeReceiveSession) &&
      !["completed", "failed", "canceled"].includes(activeReceiveSession?.status ?? "") &&
      receiveAvailabilityKeyRef.current === nextReceiveAvailabilityKey;

    if (hasUsableSession || isStartingReceiveAvailabilityRef.current) {
      return;
    }

    void ensureReceiveAvailability({
      preserveNotice: true,
      showReceivingScreen: false,
      surfaceErrors: mode === "receiving",
    });
  }, [activeHttpShareSession, activeReceiveSession, deviceName, mode, premiumAccess.isPremium, serviceInstanceId]);

  useEffect(() => {
    const sessionId = activeHttpShareSession?.id;
    if (!sessionId) {
      return;
    }

    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        return;
      }

      void stopBrowserShareSession({
        sessionId,
        noticeMessage: "Browser sharing stopped because the app left the foreground.",
      });
    });

    return () => {
      subscription.remove();
    };
  }, [activeHttpShareSession?.id]);

  useEffect(() => {
    if (isFocused || !activeHttpShareSession) {
      return;
    }

    void stopBrowserShareSession({
      sessionId: activeHttpShareSession.id,
      noticeMessage: "Browser sharing stopped because you left the share screen.",
    });
  }, [activeHttpShareSession, isFocused]);

  useEffect(() => {
    const sessionId = activeHttpShareSession?.id;
    return () => {
      if (sessionId) {
        void stopHttpShareSession(sessionId);
      }
    };
  }, [activeHttpShareSession?.id]);

  const totalStagedBytes = useMemo(() => stagedFiles.reduce((sum, file) => sum + file.sizeBytes, 0), [stagedFiles]);
  function handleSendSessionUpdate(nextSession: TransferSession) {
    logTransferScreenDebug("Received send session update", {
      sessionId: getDebugSessionId(nextSession.id),
      status: nextSession.status,
      phase: nextSession.progress.phase,
      awaitingReceiverResponse: nextSession.awaitingReceiverResponse,
      detail: nextSession.progress.detail,
      bytesTransferred: nextSession.progress.bytesTransferred,
      totalBytes: nextSession.progress.totalBytes,
      peerDeviceName: nextSession.peerDeviceName,
      currentMode: mode,
    });

    setActiveSendSession(nextSession);
    setTransferProgress(nextSession.progress);

    if (["waiting", "connecting"].includes(nextSession.status)) {
      setMode("waiting");
      return;
    }

    if (nextSession.status === "transferring") {
      setMode("transferring");
      return;
    }

    if (
      ["completed", "failed", "canceled"].includes(nextSession.status) &&
      !handledFinalizedSendSessionIds.current.has(nextSession.id)
    ) {
      handledFinalizedSendSessionIds.current.add(nextSession.id);
      startTransition(() => {
        upsertRecentTransfer(createHistoryEntryFromSendSession(nextSession));
      });
    }

    void stopSendingTransfer(nextSession.id);

    if (nextSession.status === "completed") {
      logTransferScreenDebug("Leaving waiting screen after send completion", {
        sessionId: getDebugSessionId(nextSession.id),
        detail: nextSession.progress.detail,
      });
      startTransition(() => {
        setNotice(getTransferDetail(nextSession.progress.detail, "Transfer complete."));
      });
      setMode("transferring");
      scheduleReset({ clearFiles: true, nextMode: "idle" });
      return;
    }

    if (nextSession.status === "failed") {
      logTransferScreenDebug("Leaving waiting screen after send failure", {
        sessionId: getDebugSessionId(nextSession.id),
        detail: nextSession.progress.detail,
        peerDeviceName: nextSession.peerDeviceName,
      });
      startTransition(() => {
        setNotice(getTransferDetail(nextSession.progress.detail, "The transfer could not be completed."));
      });
      setActiveSendSession(null);
      setTransferProgress(null);
      setMode("sending");
      return;
    }

    logTransferScreenDebug("Leaving send session screen after terminal status", {
      sessionId: getDebugSessionId(nextSession.id),
      status: nextSession.status,
      detail: nextSession.progress.detail,
      nextMode: stagedFiles.length > 0 ? "sending" : "idle",
    });
    setActiveSendSession(null);
    setTransferProgress(null);
    setMode(stagedFiles.length > 0 ? "sending" : "idle");
  }

  async function handlePickFiles(append = false) {
    if (activeHttpShareSession) {
      await stopBrowserShareSession({
        sessionId: activeHttpShareSession.id,
        noticeMessage: null,
      });
    }

    const { error: pickError, files } = await pickTransferFilesSafely();
    if (pickError) {
      const message = pickError instanceof Error ? pickError.message : "Unable to add these files.";
      setSelectionError(null);
      setNotice(message);
      showBanner({
        description: message,
        title: "Unable to add files",
      });
      return;
    }

    if (!files || files.length === 0) {
      return;
    }

    const nextFiles = append ? [...stagedFiles, ...files] : files;
    const validationError = getSelectionValidationError(nextFiles, premiumAccess.isPremium);
    if (validationError) {
      if (isTransferSizeLimitError(validationError)) {
        surfaceSelectionError({
          description: validationError.description,
          title: validationError.title,
        });
        return;
      }

      const message = validationError instanceof Error ? validationError.message : "Unable to add these files.";
      setSelectionError(null);
      setNotice(message);
      showBanner({
        description: message,
        title: "Unable to add files",
      });
      return;
    }

    setSelectionError(null);
    setNotice(null);
    setShowQrCode(false);
    setStagedFiles(nextFiles);
    setMode("sending");
  }

  function handleRemoveFile(index: number) {
    setSelectionError(null);
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

    if (activeHttpShareSession) {
      await stopBrowserShareSession({
        sessionId: activeHttpShareSession.id,
        noticeMessage: null,
      });
      return;
    }

    if (activeSendSession) {
      await stopSendingTransfer(activeSendSession.id);
    }

    if (mode === "receiving" && activeReceiveSession?.status === "waiting" && activeReceiveSession.incomingOffer) {
      await declineIncomingTransferOffer(activeReceiveSession.id);
    }

    setActiveSendSession(null);
    setTransferProgress(null);
    setNotice(null);
    setSelectionError(null);
    setShowQrCode(false);
    setMode(stagedFiles.length > 0 ? "sending" : "idle");
  }

  async function handleStartReceiving() {
    setSelectionError(null);
    const ready = await ensureReceiveAvailability({
      preserveNotice: false,
      showReceivingScreen: true,
      surfaceErrors: true,
    });

    if (ready) {
      setShowQrCode(false);
      setMode("receiving");
    }
  }

  async function handleSendToReceiver(record: DiscoveryRecord) {
    if (stagedFiles.length === 0) {
      logTransferScreenDebug("Ignoring send request because no staged files are available", {
        targetSessionId: getDebugSessionId(record.sessionId),
        targetMethod: record.method,
      });
      return;
    }

    logTransferScreenDebug("Starting send flow to receiver", {
      targetSessionId: getDebugSessionId(record.sessionId),
      targetMethod: record.method,
      targetDeviceName: record.deviceName,
      targetHost: record.host,
      targetPort: record.port,
      stagedFileCount: stagedFiles.length,
      stagedBytes: stagedFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
    });
    setNotice(null);
    setSelectionError(null);
    setTransferProgress(null);
    setMode("waiting");

    try {
      const session = await startSendingTransfer({
        files: stagedFiles,
        target: record,
        deviceName,
        isPremium: premiumAccess.isPremium,
        updateSession: handleSendSessionUpdate,
      });

      logTransferScreenDebug("Send session started", {
        sessionId: getDebugSessionId(session.id),
        status: session.status,
        awaitingReceiverResponse: session.awaitingReceiverResponse,
        detail: session.progress.detail,
        peerDeviceName: session.peerDeviceName,
      });
      setActiveSendSession(session);
      setTransferProgress(session.progress);
    } catch (error) {
      logTransferScreenDebug("Leaving waiting screen because send start threw", {
        targetSessionId: getDebugSessionId(record.sessionId),
        targetMethod: record.method,
        targetDeviceName: record.deviceName,
        ...getDebugErrorDetails(error),
      });
      if (isTransferSizeLimitError(error)) {
        surfaceSelectionError({
          description: error.description,
          title: error.title,
        });
      } else {
        setSelectionError(null);
        setNotice(error instanceof Error ? error.message : "Unable to start this transfer.");
      }
      setActiveSendSession(null);
      setTransferProgress(null);
      setMode("sending");
    }
  }

  async function handleStartBrowserShare() {
    if (stagedFiles.length === 0) {
      setNotice("Pick files first.");
      setMode("idle");
      return;
    }

    try {
      if (activeHttpShareSession) {
        await stopBrowserShareSession({
          sessionId: activeHttpShareSession.id,
          noticeMessage: null,
        });
      }

      setNotice(null);
      setSelectionError(null);
      setTransferProgress(null);
      setShowQrCode(false);

      const session = await startHttpShareSession({
        files: stagedFiles,
        deviceName,
        isPremium: premiumAccess.isPremium,
        updateSession: handleHttpShareSessionUpdate,
      });

      setActiveHttpShareSession(session);
      setMode("sharing");
    } catch (error) {
      setActiveHttpShareSession(null);
      setMode(stagedFiles.length > 0 ? "sending" : "idle");
      if (isTransferSizeLimitError(error)) {
        surfaceSelectionError({
          description: error.description,
          title: error.title,
        });
        return;
      }

      setSelectionError(null);
      setNotice(error instanceof Error ? error.message : "Unable to start browser sharing.");
    }
  }

  async function handleAcceptIncomingOffer() {
    if (!activeReceiveSession) {
      return;
    }

    await acceptIncomingTransferOffer(activeReceiveSession.id);
  }

  async function handleDeclineIncomingOffer() {
    if (!activeReceiveSession) {
      return;
    }

    await declineIncomingTransferOffer(activeReceiveSession.id);
    setNotice(null);
  }

  const handlePendingScannedReceiver = useEffectEvent(async (record: DiscoveryRecord) => {
    setPendingScannedReceiver(null);

    if (stagedFiles.length === 0) {
      setNotice("Pick files first.");
      return;
    }

    await handleSendToReceiver(record);
  });

  useEffect(() => {
    if (!isFocused || !pendingScannedReceiver) {
      return;
    }

    void handlePendingScannedReceiver(pendingScannedReceiver);
  }, [isFocused, pendingScannedReceiver]);

  function handleScanQrPress() {
    setNotice(null);
    setSelectionError(null);
    setPendingScannedReceiver(null);
    router.push("/scan-receiver-qr");
  }

  const currentProgress = transferProgress ?? activeSendSession?.progress ?? activeReceiveSession?.progress ?? null;
  const progressPercent =
    currentProgress && currentProgress.totalBytes > 0
      ? Math.round((currentProgress.bytesTransferred / currentProgress.totalBytes) * 100)
      : 0;
  const canShowReceiverQr = Boolean(activeReceiveSession?.qrPayload);
  const incomingOffer = activeReceiveSession?.incomingOffer;
  const currentTransferName =
    activeSendSession?.peerDeviceName ??
    activeReceiveSession?.peerDeviceName ??
    activeReceiveSession?.incomingOffer?.senderDeviceName ??
    "Nearby device";
  const transferTitle =
    currentProgress?.phase === "waiting"
      ? "Waiting for response"
      : progressPercent >= 100
        ? "Complete!"
        : "Transferring...";
  const shouldShowTransferMetrics =
    currentProgress?.phase === "transferring" && currentProgress.bytesTransferred < currentProgress.totalBytes;
  const transferSpeedLabel = shouldShowTransferMetrics
    ? formatTransferSpeed(currentProgress.speedBytesPerSecond)
    : null;
  const transferEtaLabel = shouldShowTransferMetrics ? formatTransferEta(currentProgress) : null;

  if (mode === "idle") {
    return (
      <View style={[styles.root, { paddingTop: screenTopPadding, paddingBottom: compactBottomPadding }]}>
        <View style={styles.idleWrap}>
          <LargeActionCard
            icon={<Upload color={designTheme.primaryForeground} size={48} strokeWidth={1.7} />}
            label={"Send files"}
            primary
            onPress={() => {
              void handlePickFiles(false);
            }}
          />
          <LargeActionCard
            icon={<Download color={designTheme.foreground} size={48} strokeWidth={1.7} />}
            label={"Receive files"}
            onPress={() => {
              void handleStartReceiving();
            }}
          />
          {selectionError ? (
            <View style={styles.noticeCardWrap}>
              <InlineNotice description={selectionError.description} title={selectionError.title} tone={"danger"} />
            </View>
          ) : null}
          {notice ? <Text style={styles.centerNotice}>{notice}</Text> : null}
        </View>
      </View>
    );
  }

  if (mode === "sending") {
    return (
      <View style={[styles.root, { paddingTop: screenTopPadding }]}>
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
          {selectionError ? (
            <InlineNotice description={selectionError.description} title={selectionError.title} tone={"danger"} />
          ) : null}

          <View style={styles.discoverySection}>
            <Text style={styles.discoveryTitle}>Choose a receiver</Text>
            <Text style={styles.discoveryHint}>
              Pick a nearby device, scan its QR code, or share these files in a browser on the same WiFi network.
            </Text>
          </View>

          <View style={styles.browserShareAction}>
            <OutlineButton
              label={"Share in browser"}
              icon={<Globe color={designTheme.primary} size={16} strokeWidth={2} />}
              onPress={() => {
                void handleStartBrowserShare();
              }}
            />
          </View>

          {nearbyRecords.length > 0 ? (
            <View style={styles.stack}>
              {nearbyRecords.map((record) => (
                <NearbyDeviceRow
                  key={`${record.sessionId}-${record.method}`}
                  record={record}
                  onPress={() => void handleSendToReceiver(record)}
                />
              ))}
            </View>
          ) : (
            <View style={styles.emptySearchState}>
              <View style={styles.emptySearchIcon}>
                <ActivityIndicator color={designTheme.mutedForeground} size={"small"} />
              </View>
              <Text style={styles.emptySearchLabel}>Looking for receivers...</Text>
            </View>
          )}
        </ScrollView>

        <View style={[styles.footerArea, { paddingBottom: footerBottomPadding }]}>
          <Text style={styles.footerMeta}>
            {stagedFiles.length} file{stagedFiles.length === 1 ? "" : "s"} · {formatBytes(totalStagedBytes)}
          </Text>
          <OutlineButton
            label={"Scan receiver QR code"}
            icon={<QrCode color={designTheme.primary} size={16} strokeWidth={2} />}
            onPress={handleScanQrPress}
          />
          {notice ? <Text style={styles.footerNotice}>{notice}</Text> : null}
        </View>
      </View>
    );
  }

  if (mode === "waiting") {
    return (
      <View style={[styles.root, { paddingTop: screenTopPadding, paddingBottom: regularBottomPadding }]}>
        <View style={styles.centerWrap}>
          <WaitingPulse />
          <Text style={styles.centerTitle}>
            {activeSendSession?.awaitingReceiverResponse ? "Waiting for receiver" : "Preparing transfer"}
          </Text>
          <Text style={styles.centerSubtitle}>
            {activeSendSession?.awaitingReceiverResponse
              ? `${activeSendSession.peerDeviceName ?? "Nearby device"} needs to accept this transfer.`
              : (currentProgress?.detail ?? "Connecting to the receiver.")}
          </Text>
          <Text style={styles.centerMeta}>
            {stagedFiles.length} file{stagedFiles.length === 1 ? "" : "s"} · {formatBytes(totalStagedBytes)}
          </Text>
          <OutlineButton
            label={"Cancel"}
            onPress={() => {
              void handleCancel();
            }}
          />
          {notice ? <Text style={styles.centerNotice}>{notice}</Text> : null}
        </View>
      </View>
    );
  }

  if (mode === "receiving") {
    if (incomingOffer && activeReceiveSession?.status === "waiting") {
      return (
        <View style={[styles.root, { paddingTop: screenTopPadding, paddingBottom: regularBottomPadding }]}>
          <View style={styles.centerWrap}>
            <View style={styles.transferAvatar}>
              <Smartphone color={designTheme.secondaryForeground} size={30} strokeWidth={1.8} />
            </View>

            <Text style={styles.centerTitle}>{incomingOffer.senderDeviceName}</Text>
            <Text style={styles.centerSubtitle}>wants to send files to this device</Text>
            <Text style={styles.centerMeta}>
              {incomingOffer.fileCount} file{incomingOffer.fileCount === 1 ? "" : "s"} ·{" "}
              {formatBytes(incomingOffer.totalBytes)}
            </Text>

            <View style={styles.approvalActions}>
              <View style={styles.approvalAction}>
                <OutlineButton
                  label={"Decline"}
                  icon={<X color={designTheme.foreground} size={18} strokeWidth={2} />}
                  labelStyle={styles.approvalActionLabel}
                  onPress={() => {
                    void handleDeclineIncomingOffer();
                  }}
                  style={styles.approvalActionButton}
                />
              </View>
              <View style={styles.approvalAction}>
                <PrimaryButton
                  label={"Accept"}
                  icon={<Download color={designTheme.primaryForeground} size={18} strokeWidth={2} />}
                  labelStyle={styles.approvalActionLabel}
                  onPress={() => {
                    void handleAcceptIncomingOffer();
                  }}
                  style={styles.approvalActionButton}
                />
              </View>
            </View>
            {notice ? <Text style={styles.centerNotice}>{notice}</Text> : null}
          </View>
        </View>
      );
    }

    return (
      <View style={[styles.root, { paddingTop: screenTopPadding }]}>
        <View style={styles.topBar}>
          <Text style={styles.sectionTitle}>Ready to receive</Text>
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
          <View style={styles.discoverySection}>
            <Text style={styles.discoveryTitle}>{deviceName}</Text>
            <Text style={styles.discoveryHint}>Senders can choose this device from nearby discovery or with QR.</Text>
          </View>

          <View style={styles.emptySearchState}>
            <View style={styles.emptySearchIcon}>
              <ActivityIndicator color={designTheme.primary} size={"small"} />
            </View>
            <Text style={styles.emptySearchLabel}>Listening for incoming transfers...</Text>
          </View>

          {canShowReceiverQr ? (
            <>
              <Pressable
                onPress={() => setShowQrCode((current) => !current)}
                style={({ pressed }) => [styles.textButton, pressed ? styles.pressed : null]}
              >
                <View style={styles.textButtonContent}>
                  <QrCode color={designTheme.primary} size={16} strokeWidth={2} />
                  <Text style={styles.textButtonLabel}>{showQrCode ? "Hide QR code" : "Show QR code"}</Text>
                </View>
              </Pressable>
              {showQrCode ? (
                <View style={styles.qrCard}>
                  <QRCode value={activeReceiveSession?.qrPayload ?? ""} size={172} color={designTheme.foreground} />
                </View>
              ) : null}
            </>
          ) : null}

          {notice ? <Text style={styles.receivingNotice}>{notice}</Text> : null}
        </ScrollView>
        <View style={{ paddingBottom: bottomLinkPadding }} />
      </View>
    );
  }

  if (mode === "sharing" && activeHttpShareSession) {
    return (
      <View style={[styles.root, { paddingTop: screenTopPadding }]}>
        <View style={styles.topBar}>
          <Text style={styles.sectionTitle}>Sharing in browser</Text>
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
          <View style={styles.discoverySection}>
            <Text style={styles.discoveryTitle}>{deviceName}</Text>
            <Text style={styles.discoveryHint}>
              Open this QR code or URL from another device on the same WiFi network.
            </Text>
          </View>

          <View style={styles.qrCard}>
            <QRCode value={activeHttpShareSession.qrValue} size={172} color={designTheme.foreground} />
          </View>

          <View style={styles.shareCard}>
            <Text style={styles.shareCardTitle}>Share URL</Text>
            <Text selectable style={styles.shareUrlValue}>
              {activeHttpShareSession.shareUrl}
            </Text>
            <View style={styles.shareMetaRow}>
              <Text style={styles.shareMetaLabel}>Files</Text>
              <Text style={styles.shareMetaValue}>
                {activeHttpShareSession.files.length} file{activeHttpShareSession.files.length === 1 ? "" : "s"}
              </Text>
            </View>
            <View style={styles.shareMetaRow}>
              <Text style={styles.shareMetaLabel}>Total size</Text>
              <Text style={styles.shareMetaValue}>{formatBytes(activeHttpShareSession.totalBytes)}</Text>
            </View>
          </View>

          <View style={styles.discoverySection}>
            <Text style={styles.discoveryTitle}>Files</Text>
            <Text style={styles.discoveryHint}>
              These files stay available only while the app is active on this screen.
            </Text>
          </View>

          <View style={styles.stack}>
            {activeHttpShareSession.files.map((file) => (
              <FileRow key={file.id} file={file} />
            ))}
          </View>

          {activeHttpShareSession.detail ? (
            <Text style={styles.receivingNotice}>{activeHttpShareSession.detail}</Text>
          ) : null}
          {notice ? <Text style={styles.receivingNotice}>{notice}</Text> : null}
        </ScrollView>

        <View style={[styles.footerArea, { paddingBottom: footerBottomPadding }]}>
          <Text style={styles.footerMeta}>
            {activeHttpShareSession.files.length} file{activeHttpShareSession.files.length === 1 ? "" : "s"} ·{" "}
            {formatBytes(activeHttpShareSession.totalBytes)}
          </Text>
          <OutlineButton
            label={"Stop sharing"}
            icon={<X color={designTheme.foreground} size={16} strokeWidth={2} />}
            onPress={() => {
              void handleCancel();
            }}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: screenTopPadding, paddingBottom: roomyBottomPadding }]}>
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
                  backgroundColor: progressPercent >= 100 ? designTheme.success : designTheme.primary,
                },
              ]}
            />
          </View>
          <Text style={styles.progressLabel}>{progressPercent}%</Text>
        </View>
        {shouldShowTransferMetrics ? (
          <View style={styles.transferMetricsRow}>
            <View style={styles.transferMetricCard}>
              <Text style={styles.transferMetricLabel}>Speed</Text>
              <Text style={styles.transferMetricValue}>{transferSpeedLabel}</Text>
            </View>
            <View style={styles.transferMetricCard}>
              <Text style={styles.transferMetricLabel}>ETA</Text>
              <Text style={styles.transferMetricValue}>{transferEtaLabel}</Text>
            </View>
          </View>
        ) : null}
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
    gap: 10,
  },
  noticeCardWrap: {
    maxWidth: 320,
    width: "100%",
  },
  idleWrap: {
    alignItems: "center",
    flex: 1,
    gap: 14,
    justifyContent: "center",
  },
  actionCard: {
    alignItems: "center",
    borderRadius: 20,
    gap: 14,
    justifyContent: "center",
    maxWidth: 320,
    minHeight: 196,
    paddingHorizontal: 24,
    paddingVertical: 28,
    width: "100%",
  },
  primaryActionCard: {
    backgroundColor: designTheme.primary,
  },
  secondaryActionCard: {
    backgroundColor: designTheme.secondary,
  },
  actionCardLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 24,
  },
  primaryActionLabel: {
    color: designTheme.primaryForeground,
  },
  topBar: {
    alignItems: "center",
    borderBottomColor: designTheme.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 18,
    paddingBottom: 14,
  },
  sectionTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 20,
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 999,
    justifyContent: "center",
    minHeight: 36,
    minWidth: 36,
  },
  fileRow: {
    alignItems: "center",
    backgroundColor: designTheme.muted,
    borderRadius: 14,
    flexDirection: "row",
    gap: 14,
    padding: 14,
  },
  fileIconWrap: {
    alignItems: "center",
    backgroundColor: designTheme.card,
    borderRadius: 12,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  fileCopy: {
    flex: 1,
    gap: 2,
  },
  fileName: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  fileMeta: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
  },
  addFilesButton: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 14,
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  addFilesLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  browserShareAction: {
    marginBottom: 24,
  },
  footerArea: {
    borderTopColor: designTheme.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
    paddingBottom: 12,
    paddingTop: 14,
  },
  footerMeta: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    textAlign: "center",
  },
  footerNotice: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
  discoverySection: {
    gap: 6,
    marginBottom: 18,
    marginTop: 24,
  },
  discoveryTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 18,
  },
  discoveryHint: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: designTheme.primary,
    borderRadius: 14,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 50,
    paddingHorizontal: 18,
  },
  primaryButtonLabel: {
    color: designTheme.primaryForeground,
    fontFamily: designFonts.medium,
    fontSize: 16,
  },
  outlineButton: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: designTheme.secondary,
    borderColor: designTheme.border,
    borderRadius: 14,
    borderWidth: 0,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 18,
  },
  outlineButtonLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  disabled: {
    opacity: 0.5,
  },
  waitingPulseWrap: {
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  waitingPulseOuter: {
    alignItems: "center",
    backgroundColor: "rgba(37, 99, 235, 0.08)",
    borderRadius: 48,
    height: 96,
    justifyContent: "center",
    width: 96,
  },
  waitingPulseOuterNeutral: {
    backgroundColor: designTheme.secondary,
  },
  centerWrap: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  centerTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 28,
    marginBottom: 8,
    textAlign: "center",
  },
  centerSubtitle: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 16,
    textAlign: "center",
  },
  centerMeta: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    marginBottom: 24,
  },
  approvalActions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
    width: "100%",
    maxWidth: 320,
  },
  approvalAction: {
    flex: 1,
  },
  approvalActionButton: {
    minHeight: 50,
    width: "100%",
  },
  approvalActionLabel: {
    fontSize: 16,
  },
  centerNotice: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 12,
    textAlign: "center",
  },
  textButton: {
    marginTop: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  textButtonContent: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  textButtonLabel: {
    color: designTheme.primary,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  qrCard: {
    backgroundColor: designTheme.muted,
    borderColor: designTheme.border,
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 12,
    padding: 16,
  },
  shareCard: {
    backgroundColor: designTheme.muted,
    borderColor: designTheme.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    marginTop: 20,
    padding: 16,
  },
  shareCardTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 16,
  },
  shareUrlValue: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 14,
    lineHeight: 21,
  },
  shareMetaRow: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  shareMetaLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
  },
  shareMetaValue: {
    color: designTheme.foreground,
    flex: 1,
    fontFamily: designFonts.medium,
    fontSize: 13,
    textAlign: "right",
  },
  deviceRow: {
    alignItems: "center",
    backgroundColor: designTheme.muted,
    borderRadius: 14,
    flexDirection: "row",
    gap: 12,
    padding: 14,
  },
  deviceAvatar: {
    alignItems: "center",
    backgroundColor: designTheme.card,
    borderRadius: 999,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  deviceCopy: {
    flex: 1,
    gap: 2,
  },
  deviceName: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  deviceMeta: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
  },
  emptySearchState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 56,
  },
  emptySearchIcon: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 999,
    height: 64,
    justifyContent: "center",
    marginBottom: 16,
    width: 64,
  },
  emptySearchLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 15,
  },
  receivingNotice: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 16,
    textAlign: "center",
  },
  bottomLink: {
    alignItems: "center",
    paddingVertical: 16,
  },
  bottomLinkLabel: {
    color: designTheme.primary,
    fontFamily: designFonts.medium,
    fontSize: 15,
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
    height: 72,
    justifyContent: "center",
    marginBottom: 20,
    width: 72,
  },
  transferAvatarLabel: {
    color: designTheme.secondaryForeground,
    fontFamily: designFonts.semibold,
    fontSize: 28,
  },
  transferTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 28,
    marginBottom: 8,
    textAlign: "center",
  },
  transferSubtitle: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 15,
    marginBottom: 24,
    textAlign: "center",
  },
  progressWrap: {
    maxWidth: 320,
    width: "100%",
  },
  progressTrack: {
    backgroundColor: designTheme.secondary,
    borderRadius: 999,
    height: 6,
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
    fontSize: 13,
    textAlign: "center",
  },
  transferMetricsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 14,
    maxWidth: 320,
    width: "100%",
  },
  transferMetricCard: {
    backgroundColor: designTheme.muted,
    borderColor: designTheme.border,
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  transferMetricLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 12,
    textTransform: "uppercase",
  },
  transferMetricValue: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  transferFileName: {
    color: designTheme.foreground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 16,
    textAlign: "center",
  },
  transferDetail: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 10,
    textAlign: "center",
  },
  pressed: {
    opacity: 0.72,
  },
});
