import { useIsFocused } from "@react-navigation/native";
import React, { startTransition, useEffect, useEffectEvent, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File,
  FileText,
  Film,
  Folder,
  FolderOpen,
  ImageIcon,
  Link2,
  Music,
  RefreshCw,
  Share2,
  Trash2,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { InlineNotice } from "@/components/ui";
import { useCreateHostedShareLink, useDeleteHostedFile, useHostedFiles } from "@/hooks/queries";
import { usePremiumAccess } from "@/hooks/use-premium-access";
import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { getTabScreenBottomPadding, getTabScreenTopInset } from "@/lib/design/tab-screen-insets";
import { designFonts, designTheme } from "@/lib/design/theme";
import {
  deleteReceivedFileAsync,
  formatBytes,
  getReceivedFilesDirectoryUri,
  normalizeHostedPasscode,
  isReceivedFileInDownloadsFolder,
  listDownloadsFolder,
  openReceivedFileAsync,
  shareHostedLinksAsync,
  shareReceivedFileAsync,
  type DownloadsFolderEntry,
  type DownloadsFolderSnapshot,
  type HostedFile,
  type ReceivedFileRecord,
} from "@/lib/file-transfer";
import { FILE_TRANSFERS_PRO_NAME } from "@/lib/subscriptions";
import { useAppStore, useRecentTransfers } from "@/store";

interface DownloadedFileItem extends ReceivedFileRecord {
  deviceName: string;
}

const fontStyles = {
  regular: { fontFamily: designFonts.regular },
  medium: { fontFamily: designFonts.medium },
  semibold: { fontFamily: designFonts.semibold },
} as const;

type FilesContentTab = "local" | "hosted";

function FilePreviewIcon({ type }: { type: string | null | undefined }) {
  if (type?.startsWith("image/")) {
    return <ImageIcon color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />;
  }

  if (type?.startsWith("video/")) {
    return <Film color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />;
  }

  if (type?.startsWith("audio/")) {
    return <Music color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />;
  }

  if (type?.includes("pdf") || type?.includes("document") || type?.includes("text")) {
    return <FileText color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />;
  }

  return <File color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />;
}

function formatRelativeTime(value: number | string | null | undefined) {
  if (value == null) {
    return "Unknown time";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }

  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) {
    return "Just now";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  if (diffDays === 1) {
    return "Yesterday";
  }

  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  return date.toLocaleDateString();
}

function formatFolderEntryMeta(entry: DownloadsFolderEntry) {
  if (entry.kind === "directory") {
    const itemCount = entry.childCount ?? 0;
    return `${itemCount} item${itemCount === 1 ? "" : "s"}`;
  }

  return `${formatBytes(entry.sizeBytes)} • ${formatRelativeTime(entry.modificationTime)}`;
}

async function handleOpenFile(file: Pick<ReceivedFileRecord, "uri" | "mimeType">) {
  try {
    await openReceivedFileAsync(file);
  } catch (error) {
    console.error("Unable to open downloaded file", error);

    try {
      const didShare = await shareReceivedFileAsync(file);
      if (!didShare) {
        Alert.alert("Unable to open file", "This device cannot open or share the selected file.");
      }
    } catch (shareError) {
      console.error("Unable to share downloaded file after open failed", shareError);
      Alert.alert("Unable to open file", "This device could not open the file or show the share menu.");
    }
  }
}

async function handleShareFile(file: Pick<ReceivedFileRecord, "uri" | "mimeType">) {
  try {
    const didShare = await shareReceivedFileAsync(file);
    if (!didShare) {
      Alert.alert("Sharing unavailable", "This device does not support the system share sheet.");
    }
  } catch (error) {
    console.error("Unable to share downloaded file", error);
    Alert.alert("Unable to share file", "Please try again in a moment.");
  }
}

function FilesContentTabButton({
  icon,
  isActive,
  label,
  onPress,
}: {
  icon: React.ReactNode;
  isActive: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={"tab"}
      accessibilityState={{ selected: isActive }}
      className={"min-h-[46px] flex-1 flex-row items-center justify-center gap-2 rounded-full px-4 py-3"}
      onPress={onPress}
      style={({ pressed }) => ({
        opacity: pressed ? 0.78 : 1,
        backgroundColor: isActive ? designTheme.card : "transparent",
        borderColor: isActive ? "rgba(37,99,235,0.14)" : "transparent",
        borderWidth: isActive ? 1 : 0,
      })}
    >
      {icon}
      <Text className={cn("text-[14px]", isActive ? "text-[#030213]" : "text-[#6b7280]")} style={fontStyles.medium}>
        {label}
      </Text>
    </Pressable>
  );
}

function RecentDownloadRow({
  item,
  deleting,
  onDelete,
}: {
  item: DownloadedFileItem;
  deleting: boolean;
  onDelete: (file: Pick<ReceivedFileRecord, "name" | "uri" | "mimeType">) => void;
}) {
  const savedInAppFolder = isReceivedFileInDownloadsFolder(item.uri);
  const locationLabel = savedInAppFolder
    ? "Downloads folder"
    : Platform.OS === "android"
      ? "System Downloads"
      : "Saved externally";

  return (
    <View className={"gap-3.5 px-[18px] py-4"}>
      <View className={"flex-row gap-3"}>
        <View className={"h-9 w-9 items-center justify-center rounded-xl bg-[#f3f4f6]"}>
          <FilePreviewIcon type={item.mimeType} />
        </View>
        <View className={"flex-1 gap-0.5"}>
          <Text className={"text-[15px] text-[#030213]"} numberOfLines={1} selectable style={fontStyles.medium}>
            {item.name}
          </Text>
          <Text className={"text-[13px] leading-[18px] text-[#6b7280]"} numberOfLines={2} style={fontStyles.regular}>
            {formatBytes(item.sizeBytes)} • {locationLabel} • {item.deviceName}
          </Text>
          <Text className={"text-xs text-[#6b7280]"} style={fontStyles.regular}>
            {formatRelativeTime(item.receivedAt)}
          </Text>
        </View>
      </View>

      <View className={"flex-row gap-2.5"}>
        <Pressable
          className={
            "min-h-[42px] flex-1 flex-row items-center justify-center gap-2 rounded-full border border-[#2563eb] bg-[#2563eb] px-[14px] py-2.5"
          }
          disabled={deleting}
          onPress={() => {
            void handleOpenFile(item);
          }}
          style={({ pressed }) => ({ opacity: deleting ? 0.45 : pressed ? 0.72 : 1 })}
        >
          <FolderOpen color={designTheme.primaryForeground} size={16} strokeWidth={2.2} />
          <Text className={"text-sm text-white"} style={fontStyles.semibold}>
            Open
          </Text>
        </Pressable>
        <Pressable
          className={
            "min-h-[42px] flex-1 flex-row items-center justify-center gap-2 rounded-full border border-[rgba(37,99,235,0.14)] bg-[rgba(37,99,235,0.08)] px-[14px] py-2.5"
          }
          disabled={deleting}
          onPress={() => {
            void handleShareFile(item);
          }}
          style={({ pressed }) => ({ opacity: deleting ? 0.45 : pressed ? 0.72 : 1 })}
        >
          <Share2 color={designTheme.primary} size={16} strokeWidth={2.2} />
          <Text className={"text-sm text-[#2563eb]"} style={fontStyles.semibold}>
            Share
          </Text>
        </Pressable>
        <Pressable
          className={"h-[42px] w-[42px] items-center justify-center rounded-full bg-[rgba(220,38,38,0.08)]"}
          disabled={deleting}
          onPress={() => {
            onDelete(item);
          }}
          style={({ pressed }) => ({ opacity: deleting ? 0.45 : pressed ? 0.72 : 1 })}
        >
          {deleting ? (
            <ActivityIndicator color={designTheme.destructive} size={"small"} />
          ) : (
            <Trash2 color={designTheme.destructive} size={16} strokeWidth={2.2} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

function FolderEntryRow({
  entry,
  deleting,
  onOpenDirectory,
  onDeleteFile,
}: {
  entry: DownloadsFolderEntry;
  deleting: boolean;
  onOpenDirectory: (uri: string) => void;
  onDeleteFile: (file: Pick<ReceivedFileRecord, "name" | "uri" | "mimeType">) => void;
}) {
  if (entry.kind === "directory") {
    return (
      <Pressable
        className={"flex-row items-center justify-between gap-3 px-[18px] py-[14px]"}
        onPress={() => {
          onOpenDirectory(entry.uri);
        }}
        style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
      >
        <View className={"flex-1 flex-row items-center gap-3"}>
          <View className={"h-9 w-9 items-center justify-center rounded-xl bg-[#f3f4f6]"}>
            <Folder color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />
          </View>
          <View className={"flex-1 gap-0.5"}>
            <Text className={"text-[15px] text-[#030213]"} numberOfLines={1} selectable style={fontStyles.medium}>
              {entry.name}
            </Text>
            <Text className={"text-[13px] leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
              {formatFolderEntryMeta(entry)}
            </Text>
          </View>
        </View>
        <ChevronRight color={designTheme.mutedForeground} size={18} strokeWidth={2} />
      </Pressable>
    );
  }

  return (
    <View className={"flex-row items-center justify-between gap-3 px-[18px] py-[14px]"}>
      <Pressable
        className={"flex-1 flex-row items-center gap-3 py-0.5"}
        disabled={deleting}
        onPress={() => {
          void handleOpenFile({
            uri: entry.uri,
            mimeType: entry.mimeType ?? "application/octet-stream",
          });
        }}
        style={({ pressed }) => ({ opacity: deleting ? 0.45 : pressed ? 0.72 : 1 })}
      >
        <View className={"h-9 w-9 items-center justify-center rounded-xl bg-[#f3f4f6]"}>
          <FilePreviewIcon type={entry.mimeType} />
        </View>
        <View className={"flex-1 gap-0.5"}>
          <Text className={"text-[15px] text-[#030213]"} numberOfLines={1} selectable style={fontStyles.medium}>
            {entry.name}
          </Text>
          <Text className={"text-[13px] leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
            {formatFolderEntryMeta(entry)}
          </Text>
        </View>
      </Pressable>
      <View className={"flex-row gap-2"}>
        <Pressable
          className={"h-[34px] w-[34px] items-center justify-center rounded-full bg-[rgba(37,99,235,0.08)]"}
          disabled={deleting}
          onPress={() => {
            void handleShareFile({
              uri: entry.uri,
              mimeType: entry.mimeType ?? "application/octet-stream",
            });
          }}
          style={({ pressed }) => ({ opacity: deleting ? 0.45 : pressed ? 0.72 : 1 })}
        >
          <Share2 color={designTheme.primary} size={16} strokeWidth={2.2} />
        </Pressable>
        <Pressable
          className={"h-[34px] w-[34px] items-center justify-center rounded-full bg-[rgba(220,38,38,0.08)]"}
          disabled={deleting}
          onPress={() => {
            onDeleteFile({
              name: entry.name,
              uri: entry.uri,
              mimeType: entry.mimeType ?? "application/octet-stream",
            });
          }}
          style={({ pressed }) => ({ opacity: deleting ? 0.45 : pressed ? 0.72 : 1 })}
        >
          {deleting ? (
            <ActivityIndicator color={designTheme.destructive} size={"small"} />
          ) : (
            <Trash2 color={designTheme.destructive} size={16} strokeWidth={2.2} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

function formatHostedFileMeta(hostedFile: HostedFile) {
  const formattedDate = new Date(hostedFile.expiresAt).toLocaleDateString();

  if (hostedFile.status === "expired") {
    return `Expired ${formattedDate}${hostedFile.requiresPasscode ? " • Passcode" : ""}`;
  }

  if (hostedFile.status === "pending_upload") {
    return `Upload incomplete • Created ${new Date(hostedFile.createdAt).toLocaleDateString()}`;
  }

  return `Expires ${formattedDate}${hostedFile.requiresPasscode ? " • Passcode" : ""}`;
}

function getHostedFileStatusLabel(hostedFile: HostedFile) {
  if (hostedFile.status === "expired") {
    return "Expired";
  }

  if (hostedFile.status === "pending_upload") {
    return "Upload incomplete";
  }

  return "Active";
}

function HostedFileRow({
  deleting,
  hostedFile,
  isShareDisabled,
  sharing,
  onDelete,
  onShare,
}: {
  deleting: boolean;
  hostedFile: HostedFile;
  isShareDisabled: boolean;
  sharing: boolean;
  onDelete: (file: HostedFile) => void;
  onShare: (file: HostedFile) => void;
}) {
  return (
    <View className={"gap-3.5 px-[18px] py-4"}>
      <View className={"flex-row gap-3"}>
        <View className={"h-9 w-9 items-center justify-center rounded-xl bg-[#f3f4f6]"}>
          <Link2 color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />
        </View>
        <View className={"flex-1 gap-0.5"}>
          <View className={"flex-row items-center justify-between gap-2"}>
            <Text
              className={"flex-1 text-[15px] text-[#030213]"}
              numberOfLines={1}
              selectable
              style={fontStyles.medium}
            >
              {hostedFile.fileName}
            </Text>
            <View
              className={cn(
                "rounded-full px-2.5 py-[5px]",
                hostedFile.status === "expired"
                  ? "bg-[rgba(217,119,6,0.12)]"
                  : hostedFile.status === "pending_upload"
                    ? "bg-[rgba(15,23,42,0.08)]"
                    : "bg-[rgba(22,163,74,0.1)]",
              )}
            >
              <Text
                className={cn(
                  "text-[11px]",
                  hostedFile.status === "expired"
                    ? "text-[#92400e]"
                    : hostedFile.status === "pending_upload"
                      ? "text-[#6b7280]"
                      : "text-[#16a34a]",
                )}
                style={fontStyles.semibold}
              >
                {getHostedFileStatusLabel(hostedFile)}
              </Text>
            </View>
          </View>
          <Text className={"text-[13px] leading-[18px] text-[#6b7280]"} numberOfLines={2} style={fontStyles.regular}>
            {formatBytes(hostedFile.sizeBytes)} • {formatHostedFileMeta(hostedFile)}
          </Text>
          <Text className={"text-xs text-[#6b7280]"} style={fontStyles.regular}>
            {formatRelativeTime(hostedFile.createdAt)}
          </Text>
        </View>
      </View>

      <View className={"flex-row gap-2.5"}>
        <Pressable
          className={
            "min-h-[42px] flex-1 flex-row items-center justify-center gap-2 rounded-full border border-[rgba(37,99,235,0.14)] bg-[rgba(37,99,235,0.08)] px-[14px] py-2.5"
          }
          disabled={isShareDisabled || sharing || deleting}
          onPress={() => {
            onShare(hostedFile);
          }}
          style={({ pressed }) => ({
            opacity: isShareDisabled || sharing || deleting ? 0.45 : pressed ? 0.72 : 1,
          })}
        >
          {sharing ? (
            <ActivityIndicator color={designTheme.primary} size={"small"} />
          ) : (
            <Share2 color={designTheme.primary} size={16} strokeWidth={2.2} />
          )}
          <Text className={"text-sm text-[#2563eb]"} style={fontStyles.semibold}>
            Share
          </Text>
        </Pressable>
        <Pressable
          className={
            "min-h-[42px] flex-1 flex-row items-center justify-center gap-2 rounded-full border border-[rgba(220,38,38,0.12)] bg-[rgba(220,38,38,0.08)] px-[14px] py-2.5"
          }
          disabled={sharing || deleting}
          onPress={() => {
            onDelete(hostedFile);
          }}
          style={({ pressed }) => ({ opacity: sharing || deleting ? 0.45 : pressed ? 0.72 : 1 })}
        >
          {deleting ? (
            <ActivityIndicator color={designTheme.destructive} size={"small"} />
          ) : (
            <Trash2 color={designTheme.destructive} size={16} strokeWidth={2.2} />
          )}
          <Text className={"text-sm text-[#dc2626]"} style={fontStyles.semibold}>
            Delete
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function FilesScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const topInset = getTabScreenTopInset(insets.top);
  const bottomPadding = getTabScreenBottomPadding(insets.bottom);
  const [rootDirectoryUri] = useState(() => getReceivedFilesDirectoryUri());
  const { data: session } = useSession();
  const sessionUser = session?.user ?? null;
  const isSignedIn = Boolean(sessionUser);
  const premiumAccess = usePremiumAccess();
  const hostedFilesQuery = useHostedFiles(isSignedIn);
  const createHostedShareLinkMutation = useCreateHostedShareLink();
  const deleteHostedFileMutation = useDeleteHostedFile();
  const removeReceivedFileByUri = useAppStore((state) => state.removeReceivedFileByUri);
  const recentTransfers = useRecentTransfers();
  const [folderSnapshot, setFolderSnapshot] = useState<DownloadsFolderSnapshot | null>(null);
  const [deletingUri, setDeletingUri] = useState<string | null>(null);
  const [deletingHostedFileId, setDeletingHostedFileId] = useState<string | null>(null);
  const [sharingHostedFileId, setSharingHostedFileId] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<HostedFile | null>(null);
  const [hostedPasscode, setHostedPasscode] = useState("");
  const [hostedNotice, setHostedNotice] = useState<string | null>(null);
  const [selectedContentTab, setSelectedContentTab] = useState<FilesContentTab>("local");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const downloadedFiles = useMemo(
    () =>
      recentTransfers
        .filter((entry) => entry.direction === "receive" && entry.status === "completed" && entry.files.length > 0)
        .flatMap((entry) =>
          entry.files.map((file) => ({
            ...file,
            deviceName: entry.deviceName,
          })),
        )
        .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt)),
    [recentTransfers],
  );

  const totalDownloadedBytes = useMemo(
    () => downloadedFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
    [downloadedFiles],
  );

  const systemDownloadsCount = downloadedFiles.filter((file) => !isReceivedFileInDownloadsFolder(file.uri)).length;
  const hostedFiles = isSignedIn ? (hostedFilesQuery.data ?? []) : [];

  const refreshFolder = useEffectEvent((directoryUri?: string) => {
    setIsRefreshing(true);

    try {
      const nextSnapshot = listDownloadsFolder(directoryUri ?? folderSnapshot?.uri ?? rootDirectoryUri);

      startTransition(() => {
        setFolderSnapshot(nextSnapshot);
        setLoadError(null);
      });
    } catch (error) {
      console.error("Unable to load downloads folder", error);
      startTransition(() => {
        setLoadError(error instanceof Error ? error.message : "Unable to load the downloads folder.");
      });
      setIsRefreshing(false);
      return;
    }

    setIsRefreshing(false);
  });

  useEffect(() => {
    if (!isFocused || selectedContentTab !== "local") {
      return;
    }

    refreshFolder();
  }, [isFocused, selectedContentTab]);

  const deleteFile = useEffectEvent(async (file: Pick<ReceivedFileRecord, "name" | "uri" | "mimeType">) => {
    if (deletingUri === file.uri) {
      return;
    }

    setDeletingUri(file.uri);

    try {
      await deleteReceivedFileAsync(file);
      removeReceivedFileByUri(file.uri);
      refreshFolder();
    } catch (error) {
      console.error("Unable to delete downloaded file", error);
      Alert.alert("Unable to delete file", "Please try again in a moment.");
      setDeletingUri((currentUri) => (currentUri === file.uri ? null : currentUri));
      return;
    }

    setDeletingUri((currentUri) => (currentUri === file.uri ? null : currentUri));
  });

  const confirmDeleteFile = useEffectEvent((file: Pick<ReceivedFileRecord, "name" | "uri" | "mimeType">) => {
    Alert.alert("Delete file?", `${file.name} will be removed from this device.`, [
      {
        text: "Cancel",
        style: "cancel",
      },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteFile(file);
        },
      },
    ]);
  });

  const deleteHostedFile = useEffectEvent(async (file: HostedFile) => {
    if (deletingHostedFileId === file.id) {
      return;
    }

    setDeletingHostedFileId(file.id);

    try {
      await deleteHostedFileMutation.mutateAsync({
        hostedFileId: file.id,
      });

      if (shareTarget?.id === file.id) {
        setShareTarget(null);
        setHostedPasscode("");
      }

      setHostedNotice(null);
    } catch (error) {
      console.error("Unable to delete hosted file", error);
      Alert.alert("Unable to delete hosted file", "Please try again in a moment.");
      setDeletingHostedFileId((currentId) => (currentId === file.id ? null : currentId));
      return;
    }

    setDeletingHostedFileId((currentId) => (currentId === file.id ? null : currentId));
  });

  const confirmDeleteHostedFile = useEffectEvent((file: HostedFile) => {
    Alert.alert("Delete hosted file?", `${file.fileName} will stop working for anyone with the link.`, [
      {
        text: "Cancel",
        style: "cancel",
      },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteHostedFile(file);
        },
      },
    ]);
  });

  const openHostedShareModal = useEffectEvent((file: HostedFile) => {
    setHostedNotice(null);
    setHostedPasscode("");
    setShareTarget(file);
  });

  const handleShareHostedFile = useEffectEvent(async () => {
    if (!shareTarget) {
      return;
    }

    let passcode: string | null = null;

    try {
      passcode = normalizeHostedPasscode(hostedPasscode);
    } catch (error) {
      setHostedNotice(error instanceof Error ? error.message : "Hosted link passcodes must be 6 digits.");
      return;
    }

    setSharingHostedFileId(shareTarget.id);

    try {
      const shareResult = await createHostedShareLinkMutation.mutateAsync({
        hostedFileId: shareTarget.id,
        passcode,
      });

      try {
        await shareHostedLinksAsync(
          [
            {
              fileName: shareTarget.fileName,
              shareUrl: shareResult.shareUrl,
            },
          ],
          passcode,
        );
        setHostedNotice(null);
      } catch (shareError) {
        console.error("Unable to open hosted link share sheet", shareError);
        setHostedNotice("Hosted URL created. Try sharing it again from Files in a moment.");
      }

      setShareTarget(null);
      setHostedPasscode("");
    } catch (error) {
      console.error("Unable to create hosted share link", error);
      setHostedNotice(error instanceof Error ? error.message : "Unable to create a hosted share link.");
      setSharingHostedFileId((currentId) => (currentId === shareTarget.id ? null : currentId));
      return;
    }

    setSharingHostedFileId((currentId) => (currentId === shareTarget.id ? null : currentId));
  });

  return (
    <>
      <ScrollView
        className={"flex-1 bg-white px-6"}
        contentContainerClassName={"gap-[18px]"}
        contentContainerStyle={{ paddingBottom: bottomPadding }}
        contentInsetAdjustmentBehavior={"automatic"}
        showsVerticalScrollIndicator={false}
        style={{ paddingTop: topInset + 16 }}
      >
        <Text className={"text-2xl text-[#030213]"} style={fontStyles.semibold}>
          Files
        </Text>

        <View className={"gap-3"}>
          <View
            accessibilityRole={"tablist"}
            className={"flex-row rounded-full border border-[#e5e7eb] bg-[#f9fafb] p-1"}
          >
            <FilesContentTabButton
              icon={
                <FolderOpen
                  color={selectedContentTab === "local" ? designTheme.primary : designTheme.mutedForeground}
                  size={16}
                  strokeWidth={2.1}
                />
              }
              isActive={selectedContentTab === "local"}
              label={"Local"}
              onPress={() => {
                setSelectedContentTab("local");
              }}
            />
            <FilesContentTabButton
              icon={
                <Link2
                  color={selectedContentTab === "hosted" ? designTheme.primary : designTheme.mutedForeground}
                  size={16}
                  strokeWidth={2.1}
                />
              }
              isActive={selectedContentTab === "hosted"}
              label={"Hosted"}
              onPress={() => {
                setSelectedContentTab("hosted");
              }}
            />
          </View>
          <Text className={"text-sm leading-5 text-[#6b7280]"} style={fontStyles.regular}>
            {selectedContentTab === "local"
              ? "Saved files on this device, plus the app downloads folder."
              : "Cloud-hosted links tied to your account and ready to reshare or delete."}
          </Text>
        </View>

        {selectedContentTab === "local" ? (
          <>
            <View className={"gap-3 rounded-[24px] border border-[#e5e7eb] bg-white p-[18px]"}>
              <View className={"flex-row items-center gap-3.5"}>
                <View className={"h-11 w-11 items-center justify-center rounded-full bg-[rgba(37,99,235,0.08)]"}>
                  <Download color={designTheme.primary} size={18} strokeWidth={2.2} />
                </View>
                <View className={"flex-1 gap-0.5"}>
                  <Text className={"text-[13px] uppercase text-[#6b7280]"} style={fontStyles.medium}>
                    Downloaded files
                  </Text>
                  <Text className={"text-xl text-[#030213]"} style={fontStyles.semibold}>
                    {downloadedFiles.length} saved • {formatBytes(totalDownloadedBytes)}
                  </Text>
                </View>
              </View>
              <Text className={"text-sm leading-5 text-[#6b7280]"} style={fontStyles.regular}>
                Browse your recent downloads below and inspect the app downloads folder with the folder navigator.
              </Text>
            </View>
            {downloadedFiles.length > 0 ? (
              <View className={"gap-3"}>
                <View className={"flex-row items-center justify-between gap-3"}>
                  <View>
                    <Text className={"text-lg text-[#030213]"} style={fontStyles.semibold}>
                      Recent downloads
                    </Text>
                    <Text className={"mt-0.5 text-[13px] leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
                      Completed transfers saved on this device.
                    </Text>
                  </View>
                </View>

                <View className={"overflow-hidden rounded-[20px] border border-[#e5e7eb] bg-white"}>
                  {downloadedFiles.map((item, index) => (
                    <View
                      key={item.id}
                      className={cn("border-b border-[#e5e7eb]", index === downloadedFiles.length - 1 && "border-b-0")}
                    >
                      <RecentDownloadRow
                        deleting={deletingUri === item.uri}
                        item={item}
                        onDelete={(file) => {
                          confirmDeleteFile(file);
                        }}
                      />
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            <View className={"gap-3"}>
              <View className={"flex-row items-center justify-between gap-3"}>
                <View className={"flex-1"}>
                  <Text className={"text-lg text-[#030213]"} style={fontStyles.semibold}>
                    Downloads folder
                  </Text>
                  <Text className={"mt-0.5 text-[13px] leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
                    Tap folders to drill in, or tap files to open them.
                  </Text>
                </View>
                <Pressable
                  className={
                    "min-h-[38px] flex-row items-center gap-2 rounded-full bg-[rgba(37,99,235,0.08)] px-[14px] py-2"
                  }
                  onPress={() => {
                    refreshFolder();
                  }}
                  style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
                >
                  {isRefreshing ? (
                    <ActivityIndicator color={designTheme.primary} size={"small"} />
                  ) : (
                    <RefreshCw color={designTheme.primary} size={16} strokeWidth={2.1} />
                  )}
                  <Text className={"text-[13px] text-[#2563eb]"} style={fontStyles.medium}>
                    Refresh
                  </Text>
                </Pressable>
              </View>

              <View className={"overflow-hidden rounded-[20px] border border-[#e5e7eb] bg-white"}>
                <View className={"gap-3 px-[18px] pb-[14px] pt-4"}>
                  <View className={"flex-row flex-wrap items-center gap-1.5"}>
                    {(folderSnapshot?.breadcrumbs ?? [{ label: "Downloads", uri: rootDirectoryUri }]).map(
                      (crumb, index) => (
                        <React.Fragment key={crumb.uri}>
                          {index > 0 ? (
                            <ChevronRight color={designTheme.mutedForeground} size={14} strokeWidth={2} />
                          ) : null}
                          <Pressable
                            className={"rounded-full bg-[#f9fafb] px-2.5 py-1.5"}
                            onPress={() => {
                              refreshFolder(crumb.uri);
                            }}
                            style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
                          >
                            <Text className={"text-[13px] text-[#030213]"} numberOfLines={1} style={fontStyles.medium}>
                              {crumb.label}
                            </Text>
                          </Pressable>
                        </React.Fragment>
                      ),
                    )}
                  </View>

                  {(folderSnapshot?.uri ?? rootDirectoryUri) !== rootDirectoryUri ? (
                    <Pressable
                      className={"self-start rounded-full bg-[rgba(37,99,235,0.08)] px-3 py-2"}
                      onPress={() => {
                        const crumbs = folderSnapshot?.breadcrumbs ?? [];
                        const parentCrumb = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
                        refreshFolder(parentCrumb?.uri ?? rootDirectoryUri);
                      }}
                      style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
                    >
                      <View className={"flex-row items-center gap-1.5"}>
                        <ChevronLeft color={designTheme.primary} size={16} strokeWidth={2.1} />
                        <Text className={"text-[13px] text-[#2563eb]"} style={fontStyles.medium}>
                          Up
                        </Text>
                      </View>
                    </Pressable>
                  ) : null}
                </View>

                {Platform.OS === "android" && systemDownloadsCount > 0 ? (
                  <View className={"mx-[18px] mb-[14px] gap-1 rounded-2xl bg-[#f9fafb] px-[14px] py-3"}>
                    <Text className={"text-sm text-[#030213]"} style={fontStyles.medium}>
                      System Downloads detected
                    </Text>
                    <Text className={"text-[13px] leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
                      {systemDownloadsCount} file{systemDownloadsCount === 1 ? "" : "s"} were saved through Android's
                      public Downloads area. They still appear above even when this folder browser cannot enumerate them
                      directly.
                    </Text>
                  </View>
                ) : null}

                {loadError ? (
                  <View className={"mx-[18px] mb-[14px] gap-1 rounded-2xl bg-[#f9fafb] px-[14px] py-3"}>
                    <Text className={"text-sm text-[#030213]"} style={fontStyles.medium}>
                      Folder unavailable
                    </Text>
                    <Text className={"text-[13px] leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
                      {loadError}
                    </Text>
                  </View>
                ) : null}

                {!folderSnapshot && isRefreshing ? (
                  <View className={"flex-row items-center gap-2.5 px-[18px] pb-4"}>
                    <ActivityIndicator color={designTheme.primary} size={"small"} />
                    <Text className={"text-[13px] text-[#6b7280]"} style={fontStyles.regular}>
                      Loading downloads folder...
                    </Text>
                  </View>
                ) : null}

                {folderSnapshot && folderSnapshot.entries.length === 0 ? (
                  <View className={"items-center gap-2 px-[18px] pb-[22px] pt-2"}>
                    <Folder color={designTheme.mutedForeground} size={28} strokeWidth={1.8} />
                    <Text className={"text-[17px] text-[#030213]"} style={fontStyles.semibold}>
                      This folder is empty
                    </Text>
                    <Text className={"text-center text-sm leading-5 text-[#6b7280]"} style={fontStyles.regular}>
                      Downloaded files will show up here when they are saved inside the app folder.
                    </Text>
                  </View>
                ) : null}

                {folderSnapshot?.entries.map((entry, index) => (
                  <View
                    key={entry.uri}
                    className={cn(
                      "border-b border-[#e5e7eb]",
                      index === folderSnapshot.entries.length - 1 && "border-b-0",
                    )}
                  >
                    <FolderEntryRow
                      deleting={deletingUri === entry.uri}
                      entry={entry}
                      onDeleteFile={(file) => {
                        confirmDeleteFile(file);
                      }}
                      onOpenDirectory={(uri) => {
                        refreshFolder(uri);
                      }}
                    />
                  </View>
                ))}
              </View>
            </View>
          </>
        ) : (
          <View className={"gap-3"}>
            <View className={"flex-row items-center justify-between gap-3"}>
              <View>
                <Text className={"text-lg text-[#030213]"} style={fontStyles.semibold}>
                  Hosted files
                </Text>
                <Text className={"mt-0.5 text-[13px] leading-[18px] text-[#6b7280]"} style={fontStyles.regular}>
                  Manage the hosted URLs created from the Transfer tab.
                </Text>
              </View>
            </View>

            <View className={"overflow-hidden rounded-[20px] border border-[#e5e7eb] bg-white"}>
              {!isSignedIn ? (
                <InlineNotice
                  description={"Sign in to view, reshare, and delete hosted files tied to your account."}
                  title={"Hosted files"}
                  tone={"warning"}
                />
              ) : null}

              {isSignedIn && !premiumAccess.isPremium ? (
                <InlineNotice
                  description={`Upgrade to ${FILE_TRANSFERS_PRO_NAME} in Settings to generate fresh hosted URLs. You can still delete existing hosted files here.`}
                  title={"Hosted sharing locked"}
                  tone={"warning"}
                />
              ) : null}

              {hostedNotice ? <InlineNotice description={hostedNotice} title={"Hosted files"} /> : null}

              {isSignedIn && hostedFilesQuery.error ? (
                <InlineNotice
                  description={
                    hostedFilesQuery.error instanceof Error
                      ? hostedFilesQuery.error.message
                      : "Unable to load hosted files right now."
                  }
                  title={"Hosted files"}
                  tone={"danger"}
                />
              ) : null}

              {isSignedIn && hostedFilesQuery.isLoading && hostedFiles.length === 0 ? (
                <View className={"flex-row items-center gap-2.5 px-[18px] pb-4"}>
                  <ActivityIndicator color={designTheme.primary} size={"small"} />
                  <Text className={"text-[13px] text-[#6b7280]"} style={fontStyles.regular}>
                    Loading hosted files...
                  </Text>
                </View>
              ) : null}

              {isSignedIn && !hostedFilesQuery.isLoading && hostedFiles.length === 0 ? (
                <InlineNotice
                  description={"No hosted files yet. Create new hosted URLs from the Transfer tab."}
                  title={"No hosted files"}
                />
              ) : null}

              {hostedFiles.map((hostedFile, index) => (
                <View
                  key={hostedFile.id}
                  className={cn("border-b border-[#e5e7eb]", index === hostedFiles.length - 1 && "border-b-0")}
                >
                  <HostedFileRow
                    deleting={deletingHostedFileId === hostedFile.id}
                    hostedFile={hostedFile}
                    isShareDisabled={!premiumAccess.isPremium || hostedFile.status !== "active"}
                    onDelete={(file) => {
                      confirmDeleteHostedFile(file);
                    }}
                    onShare={(file) => {
                      openHostedShareModal(file);
                    }}
                    sharing={sharingHostedFileId === hostedFile.id}
                  />
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      <Modal
        animationType={"fade"}
        onRequestClose={() => {
          if (sharingHostedFileId) {
            return;
          }

          setShareTarget(null);
          setHostedPasscode("");
        }}
        transparent
        visible={Boolean(shareTarget)}
      >
        <View className={"flex-1 items-center justify-center bg-[rgba(15,23,42,0.28)] p-6"}>
          <View className={"w-full max-w-[420px] rounded-[24px] border border-[#e5e7eb] bg-white p-5"}>
            <Pressable
              className={"mb-3 h-9 w-9 self-end items-center justify-center rounded-full bg-[#f3f4f6]"}
              hitSlop={12}
              onPress={() => {
                if (sharingHostedFileId) {
                  return;
                }

                setShareTarget(null);
                setHostedPasscode("");
              }}
              style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
            >
              <X color={designTheme.mutedForeground} size={18} strokeWidth={2.2} />
            </Pressable>

            <View className={"gap-3.5"}>
              <Text className={"text-[22px] text-[#030213]"} style={fontStyles.semibold}>
                Share hosted URL
              </Text>
              <Text className={"text-[15px] text-[#030213]"} style={fontStyles.medium}>
                {shareTarget?.fileName ?? "Hosted file"}
              </Text>
              <Text className={"text-sm leading-5 text-[#6b7280]"} style={fontStyles.regular}>
                Leave the passcode blank to remove any current protection before generating a fresh link.
              </Text>
              <TextInput
                className={
                  "min-h-[50px] rounded-[14px] border border-[#e5e7eb] bg-[#f3f4f6] px-[14px] text-[15px] text-[#030213]"
                }
                keyboardType={"number-pad"}
                maxLength={6}
                onChangeText={setHostedPasscode}
                placeholder={
                  shareTarget?.requiresPasscode ? "Leave blank to remove current passcode" : "Optional 6-digit passcode"
                }
                placeholderTextColor={designTheme.mutedForeground}
                style={fontStyles.medium}
                value={hostedPasscode}
              />
              <View className={"flex-row gap-2.5"}>
                <Pressable
                  className={"min-h-12 flex-1 items-center justify-center rounded-[14px] bg-[#f3f4f6] px-[14px]"}
                  disabled={Boolean(sharingHostedFileId)}
                  onPress={() => {
                    setShareTarget(null);
                    setHostedPasscode("");
                  }}
                  style={({ pressed }) => ({ opacity: sharingHostedFileId ? 0.45 : pressed ? 0.72 : 1 })}
                >
                  <Text className={"text-[15px] text-[#030213]"} style={fontStyles.semibold}>
                    Cancel
                  </Text>
                </Pressable>
                <Pressable
                  className={
                    "min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-[14px] bg-[#2563eb] px-[14px]"
                  }
                  disabled={Boolean(sharingHostedFileId)}
                  onPress={() => {
                    void handleShareHostedFile();
                  }}
                  style={({ pressed }) => ({ opacity: sharingHostedFileId ? 0.45 : pressed ? 0.72 : 1 })}
                >
                  {sharingHostedFileId ? (
                    <ActivityIndicator color={designTheme.primaryForeground} size={"small"} />
                  ) : null}
                  <Text className={"text-[15px] text-white"} style={fontStyles.semibold}>
                    Share
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}
