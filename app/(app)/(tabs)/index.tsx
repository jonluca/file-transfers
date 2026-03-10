import { router } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import * as Burnt from "burnt";
import { createUploadTask, type UploadProgressData } from "expo-file-system/legacy";
import React, { startTransition, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, ScrollView, Text, TextInput, View } from "react-native";
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
import {
  useCompleteHostedUpload,
  useCreateHostedShareLink,
  useCreateHostedUpload,
  useDeleteHostedFile,
} from "@/hooks/queries";
import { usePremiumAccess } from "@/hooks/use-premium-access";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { designFonts, designTheme } from "@/lib/design/theme";
import {
  acceptIncomingTransferOffer,
  assertSelectedFilesTransferAllowed,
  declineIncomingTransferOffer,
  formatBytes,
  isTransferSizeLimitError,
  normalizeHostedPasscode,
  startHttpShareSession,
  pickTransferFiles,
  shareHostedLinksAsync,
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
import { FILE_TRANSFERS_PRO_NAME } from "@/lib/subscriptions";
import { useAppStore, useDeviceName, useServiceInstanceId } from "@/store";

type TransferMode = "idle" | "sending" | "waiting" | "receiving" | "transferring" | "sharing";

interface HostedUploadProgressState {
  bytesUploaded: number;
  totalBytes: number;
  currentFileName: string | null;
  currentFileIndex: number;
  totalFiles: number;
  detail: string;
}

const TRANSFER_SCREEN_DEBUG_PREFIX = "[TransferScreen]";
const fontStyles = {
  regular: { fontFamily: designFonts.regular },
  medium: { fontFamily: designFonts.medium },
  semibold: { fontFamily: designFonts.semibold },
} as const;

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

function ensureHostedUploadSucceeded(status: number) {
  if (status < 200 || status >= 300) {
    throw new Error(`Upload failed with status ${status}.`);
  }
}

function getHostedUploadDetail(
  phase: "preparing" | "uploading" | "finalizing" | "sharing",
  fileIndex: number,
  totalFiles: number,
) {
  if (phase === "sharing") {
    return "Opening share sheet...";
  }

  if (totalFiles <= 1) {
    if (phase === "preparing") {
      return "Preparing upload...";
    }

    if (phase === "uploading") {
      return "Uploading file...";
    }

    return "Finalizing hosted link...";
  }

  if (phase === "preparing") {
    return `Preparing file ${fileIndex} of ${totalFiles}...`;
  }

  if (phase === "uploading") {
    return `Uploading file ${fileIndex} of ${totalFiles}...`;
  }

  return `Finalizing file ${fileIndex} of ${totalFiles}...`;
}

async function uploadHostedFileAsync({
  fileUri,
  uploadHeaders,
  uploadMethod,
  uploadUrl,
  onProgress,
}: {
  fileUri: string;
  uploadHeaders: Record<string, string>;
  uploadMethod: "PUT";
  uploadUrl: string;
  onProgress?: (progress: UploadProgressData) => void;
}) {
  const uploadTask = createUploadTask(
    uploadUrl,
    fileUri,
    {
      headers: uploadHeaders,
      httpMethod: uploadMethod,
    },
    onProgress,
  );

  const uploadResult = await uploadTask.uploadAsync();

  if (!uploadResult) {
    throw new Error("Upload was canceled.");
  }

  ensureHostedUploadSucceeded(uploadResult.status);
}

function updateHostedUploadProgress(
  setHostedUploadProgress: React.Dispatch<React.SetStateAction<HostedUploadProgressState | null>>,
  nextProgress: HostedUploadProgressState | null,
) {
  startTransition(() => {
    setHostedUploadProgress(nextProgress);
  });
}

function finishHostedUploadProgress({
  setHostedUploadProgress,
  setIsCreatingHostedLinks,
}: {
  setHostedUploadProgress: React.Dispatch<React.SetStateAction<HostedUploadProgressState | null>>;
  setIsCreatingHostedLinks: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  setIsCreatingHostedLinks(false);
  updateHostedUploadProgress(setHostedUploadProgress, null);
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

function isSettledSendSession(session: TransferSession | null) {
  if (!session) {
    return true;
  }

  return ["completed", "failed", "canceled"].includes(session.status);
}

function isBlockingReceiveSession(session: ReceiveSession | null) {
  if (!session) {
    return false;
  }

  return !["discoverable", "completed", "failed", "canceled"].includes(session.status);
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
      className={cn(
        "min-h-[196px] w-full max-w-[320px] items-center justify-center gap-3.5 rounded-[20px] px-6 py-7",
        primary ? "bg-[#2563eb]" : "bg-[#f3f4f6]",
      )}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
    >
      {icon}
      <Text className={cn("text-2xl", primary ? "text-white" : "text-[#030213]")} style={fontStyles.medium}>
        {label}
      </Text>
    </Pressable>
  );
}

function HeaderButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      className={"min-h-9 min-w-9 items-center justify-center rounded-full bg-[#f3f4f6]"}
      onPress={onPress}
      hitSlop={12}
      style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
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
  className,
  labelClassName,
}: {
  label: string;
  onPress: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  labelClassName?: string;
}) {
  return (
    <Pressable
      className={cn(
        "min-h-[50px] flex-row items-center justify-center gap-2 rounded-[14px] bg-[#2563eb] px-[18px]",
        className,
      )}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: disabled ? 0.5 : pressed ? 0.72 : 1 })}
    >
      {icon}
      <Text className={cn("text-base text-white", labelClassName)} style={fontStyles.medium}>
        {label}
      </Text>
    </Pressable>
  );
}

function OutlineButton({
  label,
  onPress,
  icon,
  className,
  labelClassName,
}: {
  label: string;
  onPress: () => void;
  icon?: React.ReactNode;
  className?: string;
  labelClassName?: string;
}) {
  return (
    <Pressable
      className={cn(
        "min-h-11 self-center flex-row items-center justify-center gap-2 rounded-[14px] bg-[#f3f4f6] px-[18px]",
        className,
      )}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
    >
      {icon}
      <Text className={cn("text-[15px] text-[#030213]", labelClassName)} style={fontStyles.medium}>
        {label}
      </Text>
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
    <View className={"flex-row items-center gap-3.5 rounded-[14px] bg-[#f9fafb] p-[14px]"}>
      <View className={"h-10 w-10 items-center justify-center rounded-xl bg-white"}>
        <MimeIcon type={file.mimeType} />
      </View>
      <View className={"flex-1 gap-0.5"}>
        <Text className={"text-[15px] text-[#030213]"} numberOfLines={1} style={fontStyles.medium}>
          {file.name}
        </Text>
        <Text className={"text-[13px] text-[#6b7280]"} style={fontStyles.regular}>
          {formatBytes(file.sizeBytes)}
        </Text>
      </View>
      {onRemove ? (
        <Pressable
          className={"min-h-9 min-w-9 items-center justify-center rounded-full bg-[#f3f4f6]"}
          onPress={onRemove}
          hitSlop={12}
          style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
        >
          <X color={designTheme.mutedForeground} size={20} strokeWidth={2} />
        </Pressable>
      ) : null}
    </View>
  );
}

function NearbyDeviceRow({ record, onPress }: { record: DiscoveryRecord; onPress: () => void }) {
  return (
    <Pressable
      className={"flex-row items-center gap-3 rounded-[14px] bg-[#f9fafb] p-[14px]"}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
    >
      <View className={"h-10 w-10 items-center justify-center rounded-full bg-white"}>
        <Smartphone color={designTheme.secondaryForeground} size={18} strokeWidth={2} />
      </View>
      <View className={"flex-1 gap-0.5"}>
        <Text className={"text-[15px] text-[#030213]"} style={fontStyles.medium}>
          {record.deviceName}
        </Text>
        <Text className={"text-[13px] text-[#6b7280]"} style={fontStyles.regular}>
          Ready to receive files
        </Text>
      </View>
      <Upload color={designTheme.primary} size={18} strokeWidth={2} />
    </Pressable>
  );
}

function WaitingPulse({ tone = "primary" }: { tone?: "primary" | "neutral" }) {
  return (
    <View className={"mb-6 items-center justify-center"}>
      <View
        className={cn(
          "h-24 w-24 items-center justify-center rounded-[48px]",
          tone === "neutral" ? "bg-[#f3f4f6]" : "bg-[rgba(37,99,235,0.08)]",
        )}
      >
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
  const { data: session } = useSession();
  const sessionUser = session?.user ?? null;
  const isSignedIn = Boolean(sessionUser);
  const premiumAccess = usePremiumAccess();
  const createHostedUploadMutation = useCreateHostedUpload();
  const completeHostedUploadMutation = useCompleteHostedUpload();
  const createHostedShareLinkMutation = useCreateHostedShareLink();
  const deleteHostedFileMutation = useDeleteHostedFile();
  const upsertRecentTransfer = useAppStore((state) => state.upsertRecentTransfer);
  const [mode, setMode] = useState<TransferMode>("idle");
  const [stagedFiles, setStagedFiles] = useState<SelectedTransferFile[]>([]);
  const [activeSendSession, setActiveSendSession] = useState<TransferSession | null>(null);
  const [activeReceiveSession, setActiveReceiveSession] = useState<ReceiveSession | null>(null);
  const [activeHttpShareSession, setActiveHttpShareSession] = useState<HttpShareSession | null>(null);
  const [nearbyRecords, setNearbyRecords] = useState<DiscoveryRecord[]>([]);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hostedNotice, setHostedNotice] = useState<string | null>(null);
  const [hostedPasscode, setHostedPasscode] = useState("");
  const [hostedUploadProgress, setHostedUploadProgress] = useState<HostedUploadProgressState | null>(null);
  const [isCreatingHostedLinks, setIsCreatingHostedLinks] = useState(false);
  const [selectionError, setSelectionError] = useState<TransferSizeLimitNotice | null>(null);
  const [showQrCode, setShowQrCode] = useState(false);
  const completionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledFinalizedSendSessionIds = useRef(new Set<string>());
  const handledFinalizedReceiveSessionIds = useRef(new Set<string>());
  const stoppingHttpShareSessionIdRef = useRef<string | null>(null);
  const isStartingReceiveAvailabilityRef = useRef(false);
  const receiveAvailabilityKeyRef = useRef<string | null>(null);
  const activeSendSessionRef = useRef<TransferSession | null>(null);
  const activeReceiveSessionRef = useRef<ReceiveSession | null>(null);
  const pendingScannedReceiver = useAppStore((state) => state.pendingScannedReceiver);
  const setPendingScannedReceiver = useAppStore((state) => state.setPendingScannedReceiver);
  const ensureReceiveAvailabilityRef = useRef<
    (options?: { preserveNotice?: boolean; showReceivingScreen?: boolean; surfaceErrors?: boolean }) => Promise<boolean>
  >(async () => false);

  useEffect(() => {
    activeSendSessionRef.current = activeSendSession;
    activeReceiveSessionRef.current = activeReceiveSession;
  }, [activeReceiveSession, activeSendSession]);

  useEffect(() => {
    const shouldScanNearby = mode === "sending" && !activeHttpShareSession;
    if (!shouldScanNearby) {
      return;
    }

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void startNearbyScan({
      deviceName,
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
  }, [activeHttpShareSession, activeReceiveSession?.id, deviceName, mode]);

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

  function scheduleReset({
    clearFiles,
    nextMode,
    sendSessionId,
    receiveSessionId,
  }: {
    clearFiles: boolean;
    nextMode: TransferMode;
    sendSessionId?: string;
    receiveSessionId?: string;
  }) {
    if (completionTimeoutRef.current) {
      clearTimeout(completionTimeoutRef.current);
    }

    completionTimeoutRef.current = setTimeout(() => {
      const hasBlockingTransfer =
        !isSettledSendSession(activeSendSessionRef.current) ||
        isBlockingReceiveSession(activeReceiveSessionRef.current);

      setActiveSendSession((current) => (current?.id === sendSessionId ? null : current));
      setActiveReceiveSession((current) => (current?.id === receiveSessionId ? null : current));

      if (!hasBlockingTransfer) {
        setTransferProgress(null);
        setNotice(null);
        setShowQrCode(false);
        if (clearFiles) {
          setStagedFiles([]);
        }
        setMode(nextMode);
      }
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
      scheduleReset({ clearFiles: false, nextMode: "idle", receiveSessionId: nextSession.id });
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
      scheduleReset({ clearFiles: true, nextMode: "idle", sendSessionId: nextSession.id });
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
    setHostedNotice(null);
    setNotice(null);
    setShowQrCode(false);
    setStagedFiles(nextFiles);
    setMode("sending");
  }

  function handleRemoveFile(index: number) {
    setSelectionError(null);
    setHostedNotice(null);
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
    setHostedNotice(null);
    setHostedUploadProgress(null);
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
    setHostedNotice(null);
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
      setHostedNotice(null);
      setHostedUploadProgress(null);
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

  async function handleStartHostedShare() {
    if (stagedFiles.length === 0) {
      setHostedNotice("Pick files first.");
      setMode("idle");
      return;
    }

    if (!sessionUser) {
      setHostedNotice("Sign in first, then upgrade in Settings to create hosted URLs.");
      return;
    }

    if (!premiumAccess.isPremium) {
      setHostedNotice(`${FILE_TRANSFERS_PRO_NAME} is required to create hosted URLs.`);
      return;
    }

    let passcode: string | null = null;

    try {
      passcode = normalizeHostedPasscode(hostedPasscode);
    } catch (error) {
      setHostedNotice(error instanceof Error ? error.message : "Hosted link passcodes must be 6 digits.");
      return;
    }

    setHostedNotice(null);
    setNotice(null);
    setSelectionError(null);
    setIsCreatingHostedLinks(true);

    const totalFiles = stagedFiles.length;
    const totalBytes = totalStagedBytes;
    const sharedLinks: Array<{ fileName: string; shareUrl: string }> = [];
    const retryFiles: SelectedTransferFile[] = [];
    const createdButUnsharedFiles: string[] = [];
    const cleanupFailures: string[] = [];
    let uploadedBytes = 0;

    for (const [index, stagedFile] of stagedFiles.entries()) {
      const fileIndex = index + 1;
      const uploadedBytesBeforeFile = uploadedBytes;
      let createdHostedFileId: string | null = null;
      let completedHostedFileId: string | null = null;

      updateHostedUploadProgress(setHostedUploadProgress, {
        bytesUploaded: uploadedBytesBeforeFile,
        totalBytes,
        currentFileName: stagedFile.name,
        currentFileIndex: fileIndex,
        totalFiles,
        detail: getHostedUploadDetail("preparing", fileIndex, totalFiles),
      });

      try {
        const createResult = await createHostedUploadMutation.mutateAsync({
          fileName: stagedFile.name,
          mimeType: stagedFile.mimeType,
          sizeBytes: stagedFile.sizeBytes,
          passcode,
        });

        createdHostedFileId = createResult.hostedFile.id;

        await uploadHostedFileAsync({
          fileUri: stagedFile.uri,
          uploadHeaders: createResult.uploadHeaders,
          uploadMethod: createResult.uploadMethod,
          uploadUrl: createResult.uploadUrl,
          onProgress: (progress) => {
            const nextUploadedBytes = uploadedBytesBeforeFile + Math.min(progress.totalBytesSent, stagedFile.sizeBytes);
            updateHostedUploadProgress(setHostedUploadProgress, {
              bytesUploaded: Math.min(nextUploadedBytes, totalBytes),
              totalBytes,
              currentFileName: stagedFile.name,
              currentFileIndex: fileIndex,
              totalFiles,
              detail: getHostedUploadDetail("uploading", fileIndex, totalFiles),
            });
          },
        });

        uploadedBytes = uploadedBytesBeforeFile + stagedFile.sizeBytes;
        updateHostedUploadProgress(setHostedUploadProgress, {
          bytesUploaded: Math.min(uploadedBytes, totalBytes),
          totalBytes,
          currentFileName: stagedFile.name,
          currentFileIndex: fileIndex,
          totalFiles,
          detail: getHostedUploadDetail("finalizing", fileIndex, totalFiles),
        });

        const completed = await completeHostedUploadMutation.mutateAsync({
          hostedFileId: createResult.hostedFile.id,
        });

        completedHostedFileId = completed.id;

        const shareResult = await createHostedShareLinkMutation.mutateAsync({
          hostedFileId: completed.id,
          passcode,
        });

        sharedLinks.push({
          fileName: stagedFile.name,
          shareUrl: shareResult.shareUrl,
        });
      } catch (error) {
        logTransferScreenDebug("Hosted share failed for staged file", {
          fileName: stagedFile.name,
          hostedFileId: getDebugSessionId(createdHostedFileId),
          ...getDebugErrorDetails(error),
        });

        updateHostedUploadProgress(setHostedUploadProgress, {
          bytesUploaded: Math.min(uploadedBytes, totalBytes),
          totalBytes,
          currentFileName: stagedFile.name,
          currentFileIndex: fileIndex,
          totalFiles,
          detail: "Upload failed. Continuing with the remaining files...",
        });

        if (completedHostedFileId) {
          createdButUnsharedFiles.push(stagedFile.name);
          continue;
        }

        retryFiles.push(stagedFile);

        if (!createdHostedFileId) {
          continue;
        }

        try {
          await deleteHostedFileMutation.mutateAsync({
            hostedFileId: createdHostedFileId,
          });
        } catch (cleanupError) {
          cleanupFailures.push(stagedFile.name);
          logTransferScreenDebug("Hosted share cleanup failed", {
            fileName: stagedFile.name,
            hostedFileId: getDebugSessionId(createdHostedFileId),
            ...getDebugErrorDetails(cleanupError),
          });
        }
      }
    }

    let shareSheetError: string | null = null;

    if (sharedLinks.length > 0) {
      updateHostedUploadProgress(setHostedUploadProgress, {
        bytesUploaded: Math.min(uploadedBytes, totalBytes),
        totalBytes,
        currentFileName: sharedLinks[sharedLinks.length - 1]?.fileName ?? null,
        currentFileIndex: totalFiles,
        totalFiles,
        detail: getHostedUploadDetail("sharing", totalFiles, totalFiles),
      });

      try {
        await shareHostedLinksAsync(sharedLinks, passcode);
      } catch (error) {
        shareSheetError = error instanceof Error ? error.message : "Hosted URLs were created but could not be shared.";
      }
    }

    if (retryFiles.length === 0 && createdButUnsharedFiles.length === 0) {
      finishHostedUploadProgress({
        setHostedUploadProgress,
        setIsCreatingHostedLinks,
      });
      setHostedPasscode("");
      setHostedNotice(null);
      setStagedFiles([]);
      setMode("idle");
      setNotice(
        shareSheetError
          ? "Hosted URLs were created. Open Files to share them again."
          : `Hosted URLs ready for ${sharedLinks.length} file${sharedLinks.length === 1 ? "" : "s"}.`,
      );
      return;
    }

    finishHostedUploadProgress({
      setHostedUploadProgress,
      setIsCreatingHostedLinks,
    });
    setStagedFiles(retryFiles);
    setMode(retryFiles.length > 0 ? "sending" : "idle");

    const nextHostedMessages: string[] = [];

    if (sharedLinks.length > 0) {
      nextHostedMessages.push(
        `Shared ${sharedLinks.length} hosted URL${sharedLinks.length === 1 ? "" : "s"}${passcode ? ` with passcode ${passcode}.` : "."}`,
      );
    } else {
      nextHostedMessages.push("No hosted URLs were shared.");
    }

    if (retryFiles.length > 0) {
      nextHostedMessages.push(
        `${retryFiles.length} file${retryFiles.length === 1 ? "" : "s"} could not be uploaded and remain staged.`,
      );
    }

    if (createdButUnsharedFiles.length > 0) {
      nextHostedMessages.push(
        `${createdButUnsharedFiles.length} file${createdButUnsharedFiles.length === 1 ? "" : "s"} uploaded successfully but could not generate a share link. Open Files to share them again.`,
      );
    }

    if (cleanupFailures.length > 0) {
      nextHostedMessages.push("Delete any incomplete hosted items from Files if they appear.");
    }

    if (shareSheetError) {
      nextHostedMessages.push("The system share sheet did not open. Open Files to share the generated URLs again.");
    }

    const nextHostedMessage = nextHostedMessages.join(" ");
    if (retryFiles.length > 0) {
      setHostedNotice(nextHostedMessage);
      return;
    }

    setHostedPasscode("");
    setHostedNotice(null);
    setNotice(nextHostedMessage);
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
    setHostedNotice(null);
    setHostedUploadProgress(null);
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
  const hostedUploadPercent =
    hostedUploadProgress && hostedUploadProgress.totalBytes > 0
      ? Math.round((hostedUploadProgress.bytesUploaded / hostedUploadProgress.totalBytes) * 100)
      : 0;

  if (mode === "idle") {
    return (
      <View
        className={"flex-1 bg-white px-6"}
        style={{ paddingBottom: compactBottomPadding, paddingTop: screenTopPadding }}
      >
        <View className={"flex-1 items-center justify-center gap-3.5"}>
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
            <View className={"w-full max-w-[320px]"}>
              <InlineNotice description={selectionError.description} title={selectionError.title} tone={"danger"} />
            </View>
          ) : null}
          {notice ? (
            <Text className={"mt-3 text-center text-[13px] leading-5 text-[#6b7280]"} style={fontStyles.regular}>
              {notice}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  if (mode === "sending") {
    return (
      <View className={"flex-1 bg-white px-6"} style={{ paddingTop: screenTopPadding }}>
        <View className={"mb-[18px] flex-row items-center justify-between border-b border-[#e5e7eb] pb-[14px]"}>
          <Text className={"text-xl text-[#030213]"} style={fontStyles.semibold}>
            Ready to send
          </Text>
          <HeaderButton
            onPress={() => {
              void handleCancel();
            }}
          />
        </View>

        <ScrollView className={"flex-1"} contentContainerClassName={"pb-6"} showsVerticalScrollIndicator={false}>
          <ScrollView
            className={"max-h-[280px]"}
            contentContainerClassName={"gap-2.5"}
            nestedScrollEnabled
            showsVerticalScrollIndicator={stagedFiles.length > 3}
          >
            {stagedFiles.map((file, index) => (
              <FileRow key={file.id} file={file} onRemove={() => handleRemoveFile(index)} />
            ))}
          </ScrollView>
          <Pressable
            className={"mt-4 items-center rounded-[14px] bg-[#f3f4f6] px-4 py-[14px]"}
            onPress={() => {
              void handlePickFiles(true);
            }}
            style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
          >
            <Text className={"text-[15px] text-[#030213]"} style={fontStyles.medium}>
              Add more files
            </Text>
          </Pressable>
          {selectionError ? (
            <InlineNotice description={selectionError.description} title={selectionError.title} tone={"danger"} />
          ) : null}

          <View className={"mb-[18px] mt-6 gap-1.5"}>
            <Text className={"text-lg text-[#030213]"} style={fontStyles.semibold}>
              Choose a receiver
            </Text>
            <Text className={"text-sm leading-5 text-[#6b7280]"} style={fontStyles.regular}>
              Pick a nearby device or scan its QR code.
            </Text>
          </View>

          <View className={"mb-6"}>
            <OutlineButton
              label={"Scan QR code"}
              icon={<QrCode color={designTheme.primary} size={16} strokeWidth={2} />}
              onPress={handleScanQrPress}
            />
          </View>

          {nearbyRecords.length > 0 ? (
            <View className={"gap-2.5"}>
              {nearbyRecords.map((record) => (
                <NearbyDeviceRow
                  key={`${record.sessionId}-${record.method}`}
                  record={record}
                  onPress={() => void handleSendToReceiver(record)}
                />
              ))}
            </View>
          ) : (
            <View className={"items-center justify-center py-8"}>
              <View className={"mb-4 h-16 w-16 items-center justify-center rounded-full bg-[#f3f4f6]"}>
                <ActivityIndicator color={designTheme.mutedForeground} size={"small"} />
              </View>
              <Text className={"text-[15px] text-[#6b7280]"} style={fontStyles.regular}>
                Looking for receivers...
              </Text>
            </View>
          )}

          <View className={"mb-3 mt-6 gap-3.5 rounded-[20px] border border-[#e5e7eb] bg-white p-[18px]"}>
            <View className={"gap-1.5"}>
              <Text className={"text-lg text-[#030213]"} style={fontStyles.semibold}>
                Share over local WiFi
              </Text>
              <Text className={"text-sm leading-5 text-[#6b7280]"} style={fontStyles.regular}>
                Open a temporary browser page on this device for anyone on the same WiFi network.
              </Text>
            </View>
            <OutlineButton
              label={"Share in browser"}
              icon={<Globe color={designTheme.primary} size={16} strokeWidth={2} />}
              onPress={() => {
                void handleStartBrowserShare();
              }}
            />
          </View>

          <View className={"mb-3 gap-3.5 rounded-[20px] border border-[#e5e7eb] bg-white p-[18px]"}>
            <View className={"gap-1.5"}>
              <Text className={"text-lg text-[#030213]"} style={fontStyles.semibold}>
                Hosted URL
              </Text>
              <Text className={"text-sm leading-5 text-[#6b7280]"} style={fontStyles.regular}>
                Upload these files for 30 days and share a download link.
              </Text>
            </View>

            {hostedUploadProgress ? (
              <View className={"rounded-2xl border border-[#e5e7eb] bg-[#f9fafb] p-[14px]"}>
                <View className={"flex-row items-center justify-between gap-3"}>
                  <Text className={"flex-1 text-sm text-[#030213]"} style={fontStyles.medium}>
                    {hostedUploadProgress.detail}
                  </Text>
                  <Text className={"text-[13px] text-[#6b7280]"} style={fontStyles.medium}>
                    {hostedUploadPercent}%
                  </Text>
                </View>
                <View className={"mb-2 mt-3 h-1.5 overflow-hidden rounded-full bg-[#f3f4f6]"}>
                  <View
                    style={[
                      { borderRadius: 999, height: "100%" },
                      {
                        width: `${Math.max(0, Math.min(hostedUploadPercent, 100))}%`,
                        backgroundColor: hostedUploadPercent >= 100 ? designTheme.success : designTheme.primary,
                      },
                    ]}
                  />
                </View>
                {hostedUploadProgress.currentFileName ? (
                  <Text className={"mt-0.5 text-sm text-[#030213]"} style={fontStyles.medium}>
                    {hostedUploadProgress.currentFileName}
                  </Text>
                ) : null}
                <Text className={"text-[13px] leading-5 text-[#6b7280]"} style={fontStyles.regular}>
                  {formatBytes(hostedUploadProgress.bytesUploaded)} of {formatBytes(hostedUploadProgress.totalBytes)} ·
                  File {Math.max(1, hostedUploadProgress.currentFileIndex)} of {hostedUploadProgress.totalFiles}
                </Text>
              </View>
            ) : null}

            {isSignedIn && premiumAccess.isPremium ? (
              <>
                <TextInput
                  className={
                    "min-h-[50px] rounded-[14px] border border-[#e5e7eb] bg-[#f3f4f6] px-[14px] text-[15px] text-[#030213]"
                  }
                  keyboardType={"number-pad"}
                  maxLength={6}
                  onChangeText={setHostedPasscode}
                  placeholder={"Optional shared 6-digit passcode"}
                  placeholderTextColor={designTheme.mutedForeground}
                  style={fontStyles.medium}
                  value={hostedPasscode}
                />
                <PrimaryButton
                  className={"self-stretch"}
                  disabled={isCreatingHostedLinks}
                  icon={isCreatingHostedLinks ? <ActivityIndicator color={designTheme.primaryForeground} /> : undefined}
                  label={isCreatingHostedLinks ? "Creating hosted URLs..." : "Create hosted URLs"}
                  onPress={() => {
                    void handleStartHostedShare();
                  }}
                />
              </>
            ) : (
              <>
                <Text className={"text-sm leading-[21px] text-[#6b7280]"} style={fontStyles.regular}>
                  {isSignedIn
                    ? `Upgrade to ${FILE_TRANSFERS_PRO_NAME} in Settings to create hosted links.`
                    : `Sign in from Settings, then upgrade to ${FILE_TRANSFERS_PRO_NAME} to create hosted links.`}
                </Text>
                <OutlineButton
                  label={"Go to Settings"}
                  onPress={() => {
                    router.push("/settings");
                  }}
                />
              </>
            )}

            {hostedNotice ? <InlineNotice description={hostedNotice} title={"Hosted URL"} /> : null}
          </View>
        </ScrollView>

        <View
          className={"gap-3 border-t border-[#e5e7eb] pb-3 pt-[14px]"}
          style={{ paddingBottom: footerBottomPadding }}
        >
          <Text className={"text-center text-[13px] text-[#6b7280]"} style={fontStyles.regular}>
            {stagedFiles.length} file{stagedFiles.length === 1 ? "" : "s"} · {formatBytes(totalStagedBytes)}
          </Text>
          {notice ? (
            <Text className={"text-center text-[13px] leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
              {notice}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  if (mode === "waiting") {
    return (
      <View
        className={"flex-1 bg-white px-6"}
        style={{ paddingBottom: regularBottomPadding, paddingTop: screenTopPadding }}
      >
        <View className={"flex-1 items-center justify-center"}>
          <WaitingPulse />
          <Text className={"mb-2 text-center text-[28px] text-[#030213]"} style={fontStyles.semibold}>
            {activeSendSession?.awaitingReceiverResponse ? "Waiting for receiver" : "Preparing transfer"}
          </Text>
          <Text className={"mb-4 text-center text-[15px] leading-[22px] text-[#6b7280]"} style={fontStyles.regular}>
            {activeSendSession?.awaitingReceiverResponse
              ? `${activeSendSession.peerDeviceName ?? "Nearby device"} needs to accept this transfer.`
              : (currentProgress?.detail ?? "Connecting to the receiver.")}
          </Text>
          <Text className={"mb-6 text-[13px] text-[#6b7280]"} style={fontStyles.regular}>
            {stagedFiles.length} file{stagedFiles.length === 1 ? "" : "s"} · {formatBytes(totalStagedBytes)}
          </Text>
          <OutlineButton
            label={"Cancel"}
            onPress={() => {
              void handleCancel();
            }}
          />
          {notice ? (
            <Text className={"mt-3 text-center text-[13px] leading-5 text-[#6b7280]"} style={fontStyles.regular}>
              {notice}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  if (mode === "receiving") {
    if (incomingOffer && activeReceiveSession?.status === "waiting") {
      return (
        <View
          className={"flex-1 bg-white px-6"}
          style={{ paddingBottom: regularBottomPadding, paddingTop: screenTopPadding }}
        >
          <View className={"flex-1 items-center justify-center"}>
            <View className={"mb-5 h-[72px] w-[72px] items-center justify-center rounded-full bg-[#f3f4f6]"}>
              <Smartphone color={designTheme.secondaryForeground} size={30} strokeWidth={1.8} />
            </View>

            <Text className={"mb-2 text-center text-[28px] text-[#030213]"} style={fontStyles.semibold}>
              {incomingOffer.senderDeviceName}
            </Text>
            <Text className={"mb-4 text-center text-[15px] leading-[22px] text-[#6b7280]"} style={fontStyles.regular}>
              wants to send files to this device
            </Text>
            <Text className={"mb-6 text-[13px] text-[#6b7280]"} style={fontStyles.regular}>
              {incomingOffer.fileCount} file{incomingOffer.fileCount === 1 ? "" : "s"} ·{" "}
              {formatBytes(incomingOffer.totalBytes)}
            </Text>

            <View className={"mt-2 w-full max-w-[320px] flex-row gap-3"}>
              <View className={"flex-1"}>
                <OutlineButton
                  className={"min-h-[50px] w-full"}
                  label={"Decline"}
                  icon={<X color={designTheme.foreground} size={18} strokeWidth={2} />}
                  labelClassName={"text-base"}
                  onPress={() => {
                    void handleDeclineIncomingOffer();
                  }}
                />
              </View>
              <View className={"flex-1"}>
                <PrimaryButton
                  className={"min-h-[50px] w-full"}
                  label={"Accept"}
                  icon={<Download color={designTheme.primaryForeground} size={18} strokeWidth={2} />}
                  labelClassName={"text-base"}
                  onPress={() => {
                    void handleAcceptIncomingOffer();
                  }}
                />
              </View>
            </View>
            {notice ? (
              <Text className={"mt-3 text-center text-[13px] leading-5 text-[#6b7280]"} style={fontStyles.regular}>
                {notice}
              </Text>
            ) : null}
          </View>
        </View>
      );
    }

    return (
      <View className={"flex-1 bg-white px-6"} style={{ paddingTop: screenTopPadding }}>
        <View className={"mb-[18px] flex-row items-center justify-between border-b border-[#e5e7eb] pb-[14px]"}>
          <Text className={"text-xl text-[#030213]"} style={fontStyles.semibold}>
            Ready to receive
          </Text>
          <HeaderButton
            onPress={() => {
              void handleCancel();
            }}
          />
        </View>

        <ScrollView className={"flex-1"} contentContainerClassName={"pb-6"} showsVerticalScrollIndicator={false}>
          <View className={"mb-[18px] mt-6 gap-1.5"}>
            <Text className={"text-lg text-[#030213]"} style={fontStyles.semibold}>
              {deviceName}
            </Text>
            <Text className={"text-sm leading-5 text-[#6b7280]"} style={fontStyles.regular}>
              Senders can choose this device from nearby discovery or with QR.
            </Text>
          </View>

          <View className={"items-center justify-center py-8"}>
            <View className={"mb-4 h-16 w-16 items-center justify-center rounded-full bg-[#f3f4f6]"}>
              <ActivityIndicator color={designTheme.primary} size={"small"} />
            </View>
            <Text className={"text-[15px] text-[#6b7280]"} style={fontStyles.regular}>
              Listening for incoming transfers...
            </Text>
          </View>

          {canShowReceiverQr ? (
            <>
              <Pressable
                className={"mt-4 px-3 py-2"}
                onPress={() => setShowQrCode((current) => !current)}
                style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
              >
                <View className={"flex-row items-center gap-2"}>
                  <QrCode color={designTheme.primary} size={16} strokeWidth={2} />
                  <Text className={"text-[15px] text-[#2563eb]"} style={fontStyles.medium}>
                    {showQrCode ? "Hide QR code" : "Show QR code"}
                  </Text>
                </View>
              </Pressable>
              {showQrCode ? (
                <View className={"mt-3 items-center rounded-[18px] border border-[#e5e7eb] bg-[#f9fafb] p-4"}>
                  <QRCode value={activeReceiveSession?.qrPayload ?? ""} size={172} color={designTheme.foreground} />
                </View>
              ) : null}
            </>
          ) : null}

          {notice ? (
            <Text className={"mt-4 text-center text-[13px] leading-5 text-[#6b7280]"} style={fontStyles.regular}>
              {notice}
            </Text>
          ) : null}
        </ScrollView>
        <View style={{ paddingBottom: bottomLinkPadding }} />
      </View>
    );
  }

  if (mode === "sharing" && activeHttpShareSession) {
    return (
      <View className={"flex-1 bg-white px-6"} style={{ paddingTop: screenTopPadding }}>
        <View className={"mb-[18px] flex-row items-center justify-between border-b border-[#e5e7eb] pb-[14px]"}>
          <Text className={"text-xl text-[#030213]"} style={fontStyles.semibold}>
            Sharing in browser
          </Text>
          <HeaderButton
            onPress={() => {
              void handleCancel();
            }}
          />
        </View>

        <ScrollView className={"flex-1"} contentContainerClassName={"pb-6"} showsVerticalScrollIndicator={false}>
          <View className={"mb-[18px] mt-6 gap-1.5"}>
            <Text className={"text-lg text-[#030213]"} style={fontStyles.semibold}>
              {deviceName}
            </Text>
            <Text className={"text-sm leading-5 text-[#6b7280]"} style={fontStyles.regular}>
              Open this QR code or URL from another device on the same WiFi network.
            </Text>
          </View>

          <View className={"items-center rounded-[18px] border border-[#e5e7eb] bg-[#f9fafb] p-4"}>
            <QRCode value={activeHttpShareSession.qrValue} size={172} color={designTheme.foreground} />
          </View>

          <View className={"mt-5 gap-3 rounded-[18px] border border-[#e5e7eb] bg-[#f9fafb] p-4"}>
            <Text className={"text-base text-[#030213]"} style={fontStyles.semibold}>
              Share URL
            </Text>
            <Text className={"text-sm leading-[21px] text-[#030213]"} selectable style={fontStyles.medium}>
              {activeHttpShareSession.shareUrl}
            </Text>
            <View className={"flex-row justify-between gap-3"}>
              <Text className={"text-[13px] text-[#6b7280]"} style={fontStyles.regular}>
                Files
              </Text>
              <Text className={"flex-1 text-right text-[13px] text-[#030213]"} style={fontStyles.medium}>
                {activeHttpShareSession.files.length} file{activeHttpShareSession.files.length === 1 ? "" : "s"}
              </Text>
            </View>
            <View className={"flex-row justify-between gap-3"}>
              <Text className={"text-[13px] text-[#6b7280]"} style={fontStyles.regular}>
                Total size
              </Text>
              <Text className={"flex-1 text-right text-[13px] text-[#030213]"} style={fontStyles.medium}>
                {formatBytes(activeHttpShareSession.totalBytes)}
              </Text>
            </View>
          </View>

          <View className={"mb-[18px] mt-6 gap-1.5"}>
            <Text className={"text-lg text-[#030213]"} style={fontStyles.semibold}>
              Files
            </Text>
            <Text className={"text-sm leading-5 text-[#6b7280]"} style={fontStyles.regular}>
              These files stay available only while the app is active on this screen.
            </Text>
          </View>

          <View className={"gap-2.5"}>
            {activeHttpShareSession.files.map((file) => (
              <FileRow key={file.id} file={file} />
            ))}
          </View>

          {activeHttpShareSession.detail ? (
            <Text className={"mt-4 text-center text-[13px] leading-5 text-[#6b7280]"} style={fontStyles.regular}>
              {activeHttpShareSession.detail}
            </Text>
          ) : null}
          {notice ? (
            <Text className={"mt-4 text-center text-[13px] leading-5 text-[#6b7280]"} style={fontStyles.regular}>
              {notice}
            </Text>
          ) : null}
        </ScrollView>

        <View
          className={"gap-3 border-t border-[#e5e7eb] pb-3 pt-[14px]"}
          style={{ paddingBottom: footerBottomPadding }}
        >
          <Text className={"text-center text-[13px] text-[#6b7280]"} style={fontStyles.regular}>
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
    <View
      className={"flex-1 bg-white px-6"}
      style={{ paddingBottom: roomyBottomPadding, paddingTop: screenTopPadding }}
    >
      <View className={"flex-1 items-center justify-center"}>
        <View className={"mb-5 h-[72px] w-[72px] items-center justify-center rounded-full bg-[#f3f4f6]"}>
          <Text className={"text-[28px] text-[#4b5563]"} style={fontStyles.semibold}>
            {currentTransferName.charAt(0).toUpperCase()}
          </Text>
        </View>
        <Text className={"mb-2 text-center text-[28px] text-[#030213]"} style={fontStyles.semibold}>
          {transferTitle}
        </Text>
        <Text className={"mb-6 text-center text-[15px] text-[#6b7280]"} style={fontStyles.regular}>
          {currentTransferName}
        </Text>
        <View className={"w-full max-w-[320px]"}>
          <View className={"mb-2 h-1.5 overflow-hidden rounded-full bg-[#f3f4f6]"}>
            <View
              style={[
                { borderRadius: 999, height: "100%" },
                {
                  width: `${Math.max(0, Math.min(progressPercent, 100))}%`,
                  backgroundColor: progressPercent >= 100 ? designTheme.success : designTheme.primary,
                },
              ]}
            />
          </View>
          <Text className={"text-center text-[13px] text-[#6b7280]"} style={fontStyles.regular}>
            {progressPercent}%
          </Text>
        </View>
        {shouldShowTransferMetrics ? (
          <View className={"mt-[14px] flex-row gap-2.5 w-full max-w-[320px]"}>
            <View className={"flex-1 gap-1 rounded-[14px] border border-[#e5e7eb] bg-[#f9fafb] px-[14px] py-3"}>
              <Text className={"text-xs uppercase text-[#6b7280]"} style={fontStyles.regular}>
                Speed
              </Text>
              <Text className={"text-[15px] text-[#030213]"} style={fontStyles.medium}>
                {transferSpeedLabel}
              </Text>
            </View>
            <View className={"flex-1 gap-1 rounded-[14px] border border-[#e5e7eb] bg-[#f9fafb] px-[14px] py-3"}>
              <Text className={"text-xs uppercase text-[#6b7280]"} style={fontStyles.regular}>
                ETA
              </Text>
              <Text className={"text-[15px] text-[#030213]"} style={fontStyles.medium}>
                {transferEtaLabel}
              </Text>
            </View>
          </View>
        ) : null}
        {currentProgress?.currentFileName ? (
          <Text className={"mt-4 text-center text-sm leading-5 text-[#030213]"} style={fontStyles.regular}>
            {currentProgress.currentFileName}
          </Text>
        ) : null}
        {currentProgress?.detail ? (
          <Text className={"mt-2.5 text-center text-[13px] leading-5 text-[#6b7280]"} style={fontStyles.regular}>
            {currentProgress.detail}
          </Text>
        ) : null}
        {notice ? (
          <Text className={"mt-3 text-center text-[13px] leading-5 text-[#6b7280]"} style={fontStyles.regular}>
            {notice}
          </Text>
        ) : null}
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
