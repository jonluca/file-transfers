import { useIsFocused } from "@react-navigation/native";
import React, { startTransition, useEffect, useEffectEvent, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
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
    <View style={styles.downloadRow}>
      <View style={styles.downloadRowHeader}>
        <View style={styles.previewIconWrap}>
          <FilePreviewIcon type={item.mimeType} />
        </View>
        <View style={styles.downloadCopy}>
          <Text numberOfLines={1} selectable style={styles.downloadName}>
            {item.name}
          </Text>
          <Text numberOfLines={2} style={styles.downloadMeta}>
            {formatBytes(item.sizeBytes)} • {locationLabel} • {item.deviceName}
          </Text>
          <Text style={styles.downloadTime}>{formatRelativeTime(item.receivedAt)}</Text>
        </View>
      </View>

      <View style={styles.actionRow}>
        <Pressable
          disabled={deleting}
          onPress={() => {
            void handleOpenFile(item);
          }}
          style={({ pressed }) => [
            styles.actionButton,
            styles.actionButtonPrimary,
            deleting ? styles.disabled : null,
            pressed ? styles.pressed : null,
          ]}
        >
          <FolderOpen color={designTheme.primaryForeground} size={16} strokeWidth={2.2} />
          <Text style={[styles.actionButtonLabel, styles.actionButtonLabelPrimary]}>Open</Text>
        </Pressable>
        <Pressable
          disabled={deleting}
          onPress={() => {
            void handleShareFile(item);
          }}
          style={({ pressed }) => [
            styles.actionButton,
            styles.actionButtonSecondary,
            deleting ? styles.disabled : null,
            pressed ? styles.pressed : null,
          ]}
        >
          <Share2 color={designTheme.primary} size={16} strokeWidth={2.2} />
          <Text style={[styles.actionButtonLabel, styles.actionButtonLabelSecondary]}>Share</Text>
        </Pressable>
        <Pressable
          disabled={deleting}
          onPress={() => {
            onDelete(item);
          }}
          style={({ pressed }) => [
            styles.actionIconButton,
            styles.actionIconButtonDanger,
            deleting ? styles.disabled : null,
            pressed ? styles.pressed : null,
          ]}
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
        onPress={() => {
          onOpenDirectory(entry.uri);
        }}
        style={({ pressed }) => [styles.browserRow, pressed ? styles.pressed : null]}
      >
        <View style={styles.browserRowLead}>
          <View style={styles.previewIconWrap}>
            <Folder color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />
          </View>
          <View style={styles.browserCopy}>
            <Text numberOfLines={1} selectable style={styles.browserName}>
              {entry.name}
            </Text>
            <Text style={styles.browserMeta}>{formatFolderEntryMeta(entry)}</Text>
          </View>
        </View>
        <ChevronRight color={designTheme.mutedForeground} size={18} strokeWidth={2} />
      </Pressable>
    );
  }

  return (
    <View style={styles.browserRow}>
      <Pressable
        disabled={deleting}
        onPress={() => {
          void handleOpenFile({
            uri: entry.uri,
            mimeType: entry.mimeType ?? "application/octet-stream",
          });
        }}
        style={({ pressed }) => [
          styles.browserRowLead,
          styles.browserPressArea,
          deleting ? styles.disabled : null,
          pressed ? styles.pressed : null,
        ]}
      >
        <View style={styles.previewIconWrap}>
          <FilePreviewIcon type={entry.mimeType} />
        </View>
        <View style={styles.browserCopy}>
          <Text numberOfLines={1} selectable style={styles.browserName}>
            {entry.name}
          </Text>
          <Text style={styles.browserMeta}>{formatFolderEntryMeta(entry)}</Text>
        </View>
      </Pressable>
      <View style={styles.browserActionRow}>
        <Pressable
          disabled={deleting}
          onPress={() => {
            void handleShareFile({
              uri: entry.uri,
              mimeType: entry.mimeType ?? "application/octet-stream",
            });
          }}
          style={({ pressed }) => [
            styles.browserShareButton,
            deleting ? styles.disabled : null,
            pressed ? styles.pressed : null,
          ]}
        >
          <Share2 color={designTheme.primary} size={16} strokeWidth={2.2} />
        </Pressable>
        <Pressable
          disabled={deleting}
          onPress={() => {
            onDeleteFile({
              name: entry.name,
              uri: entry.uri,
              mimeType: entry.mimeType ?? "application/octet-stream",
            });
          }}
          style={({ pressed }) => [
            styles.browserShareButton,
            styles.browserDeleteButton,
            deleting ? styles.disabled : null,
            pressed ? styles.pressed : null,
          ]}
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
    <View style={styles.downloadRow}>
      <View style={styles.downloadRowHeader}>
        <View style={styles.previewIconWrap}>
          <Link2 color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />
        </View>
        <View style={styles.downloadCopy}>
          <View style={styles.hostedFileHeader}>
            <Text numberOfLines={1} selectable style={styles.downloadName}>
              {hostedFile.fileName}
            </Text>
            <View
              style={[
                styles.hostedStatusBadge,
                hostedFile.status === "expired"
                  ? styles.hostedStatusBadgeExpired
                  : hostedFile.status === "pending_upload"
                    ? styles.hostedStatusBadgePending
                    : null,
              ]}
            >
              <Text
                style={[
                  styles.hostedStatusBadgeLabel,
                  hostedFile.status === "expired"
                    ? styles.hostedStatusBadgeLabelExpired
                    : hostedFile.status === "pending_upload"
                      ? styles.hostedStatusBadgeLabelPending
                      : null,
                ]}
              >
                {getHostedFileStatusLabel(hostedFile)}
              </Text>
            </View>
          </View>
          <Text numberOfLines={2} style={styles.downloadMeta}>
            {formatBytes(hostedFile.sizeBytes)} • {formatHostedFileMeta(hostedFile)}
          </Text>
          <Text style={styles.downloadTime}>{formatRelativeTime(hostedFile.createdAt)}</Text>
        </View>
      </View>

      <View style={styles.actionRow}>
        <Pressable
          disabled={isShareDisabled || sharing || deleting}
          onPress={() => {
            onShare(hostedFile);
          }}
          style={({ pressed }) => [
            styles.actionButton,
            styles.actionButtonSecondary,
            isShareDisabled || sharing || deleting ? styles.disabled : null,
            pressed ? styles.pressed : null,
          ]}
        >
          {sharing ? (
            <ActivityIndicator color={designTheme.primary} size={"small"} />
          ) : (
            <Share2 color={designTheme.primary} size={16} strokeWidth={2.2} />
          )}
          <Text style={[styles.actionButtonLabel, styles.actionButtonLabelSecondary]}>Share</Text>
        </Pressable>
        <Pressable
          disabled={sharing || deleting}
          onPress={() => {
            onDelete(hostedFile);
          }}
          style={({ pressed }) => [
            styles.actionButton,
            styles.hostedDeleteButton,
            sharing || deleting ? styles.disabled : null,
            pressed ? styles.pressed : null,
          ]}
        >
          {deleting ? (
            <ActivityIndicator color={designTheme.destructive} size={"small"} />
          ) : (
            <Trash2 color={designTheme.destructive} size={16} strokeWidth={2.2} />
          )}
          <Text style={[styles.actionButtonLabel, styles.hostedDeleteButtonLabel]}>Delete</Text>
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
    if (!isFocused) {
      return;
    }

    refreshFolder();
  }, [isFocused]);

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
        contentContainerStyle={{ paddingBottom: bottomPadding, gap: 18 }}
        contentInsetAdjustmentBehavior={"automatic"}
        showsVerticalScrollIndicator={false}
        style={[styles.root, { paddingTop: topInset + 16 }]}
      >
        <Text style={styles.title}>Files</Text>

        <View style={styles.summaryCard}>
          <View style={styles.summaryHeader}>
            <View style={styles.summaryIconWrap}>
              <Download color={designTheme.primary} size={18} strokeWidth={2.2} />
            </View>
            <View style={styles.summaryCopy}>
              <Text style={styles.summaryLabel}>Downloaded files</Text>
              <Text style={styles.summaryValue}>
                {downloadedFiles.length} saved • {formatBytes(totalDownloadedBytes)}
              </Text>
            </View>
          </View>
          <Text style={styles.summaryDescription}>
            Browse your recent downloads below and inspect the app downloads folder with the folder navigator.
          </Text>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>Hosted files</Text>
              <Text style={styles.sectionDescription}>Manage the hosted URLs created from the Transfer tab.</Text>
            </View>
          </View>

          <View style={styles.card}>
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
              <View style={styles.loadingState}>
                <ActivityIndicator color={designTheme.primary} size={"small"} />
                <Text style={styles.loadingCopy}>Loading hosted files...</Text>
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
                style={[styles.rowDivider, index === hostedFiles.length - 1 ? styles.rowDividerLast : null]}
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

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>Recent downloads</Text>
              <Text style={styles.sectionDescription}>Completed transfers saved on this device.</Text>
            </View>
          </View>

          <View style={styles.card}>
            {downloadedFiles.length === 0 ? (
              <View style={styles.emptyState}>
                <View style={styles.emptyIconWrap}>
                  <File color={designTheme.mutedForeground} size={28} strokeWidth={1.8} />
                </View>
                <Text style={styles.emptyTitle}>No downloaded files yet</Text>
                <Text style={styles.emptyCopy}>
                  Received files will appear here after the first completed transfer.
                </Text>
              </View>
            ) : (
              downloadedFiles.map((item, index) => (
                <View
                  key={item.id}
                  style={[styles.rowDivider, index === downloadedFiles.length - 1 ? styles.rowDividerLast : null]}
                >
                  <RecentDownloadRow
                    deleting={deletingUri === item.uri}
                    item={item}
                    onDelete={(file) => {
                      confirmDeleteFile(file);
                    }}
                  />
                </View>
              ))
            )}
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionHeaderCopy}>
              <Text style={styles.sectionTitle}>Downloads folder</Text>
              <Text style={styles.sectionDescription}>Tap folders to drill in, or tap files to open them.</Text>
            </View>
            <Pressable
              onPress={() => {
                refreshFolder();
              }}
              style={({ pressed }) => [styles.refreshButton, pressed ? styles.pressed : null]}
            >
              {isRefreshing ? (
                <ActivityIndicator color={designTheme.primary} size={"small"} />
              ) : (
                <RefreshCw color={designTheme.primary} size={16} strokeWidth={2.1} />
              )}
              <Text style={styles.refreshButtonLabel}>Refresh</Text>
            </Pressable>
          </View>

          <View style={styles.card}>
            <View style={styles.navigatorHeader}>
              <View style={styles.breadcrumbWrap}>
                {(folderSnapshot?.breadcrumbs ?? [{ label: "Downloads", uri: rootDirectoryUri }]).map(
                  (crumb, index) => (
                    <React.Fragment key={crumb.uri}>
                      {index > 0 ? (
                        <ChevronRight color={designTheme.mutedForeground} size={14} strokeWidth={2} />
                      ) : null}
                      <Pressable
                        onPress={() => {
                          refreshFolder(crumb.uri);
                        }}
                        style={({ pressed }) => [styles.crumbButton, pressed ? styles.pressed : null]}
                      >
                        <Text numberOfLines={1} style={styles.crumbLabel}>
                          {crumb.label}
                        </Text>
                      </Pressable>
                    </React.Fragment>
                  ),
                )}
              </View>

              {(folderSnapshot?.uri ?? rootDirectoryUri) !== rootDirectoryUri ? (
                <Pressable
                  onPress={() => {
                    const crumbs = folderSnapshot?.breadcrumbs ?? [];
                    const parentCrumb = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
                    refreshFolder(parentCrumb?.uri ?? rootDirectoryUri);
                  }}
                  style={({ pressed }) => [styles.upButton, pressed ? styles.pressed : null]}
                >
                  <ChevronLeft color={designTheme.primary} size={16} strokeWidth={2.1} />
                  <Text style={styles.upButtonLabel}>Up</Text>
                </Pressable>
              ) : null}
            </View>

            {Platform.OS === "android" && systemDownloadsCount > 0 ? (
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>System Downloads detected</Text>
                <Text style={styles.noticeCopy}>
                  {systemDownloadsCount} file{systemDownloadsCount === 1 ? "" : "s"} were saved through Android's public
                  Downloads area. They still appear above even when this folder browser cannot enumerate them directly.
                </Text>
              </View>
            ) : null}

            {loadError ? (
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>Folder unavailable</Text>
                <Text style={styles.noticeCopy}>{loadError}</Text>
              </View>
            ) : null}

            {!folderSnapshot && isRefreshing ? (
              <View style={styles.loadingState}>
                <ActivityIndicator color={designTheme.primary} size={"small"} />
                <Text style={styles.loadingCopy}>Loading downloads folder...</Text>
              </View>
            ) : null}

            {folderSnapshot && folderSnapshot.entries.length === 0 ? (
              <View style={styles.emptyBrowserState}>
                <Folder color={designTheme.mutedForeground} size={28} strokeWidth={1.8} />
                <Text style={styles.emptyBrowserTitle}>This folder is empty</Text>
                <Text style={styles.emptyBrowserCopy}>
                  Downloaded files will show up here when they are saved inside the app folder.
                </Text>
              </View>
            ) : null}

            {folderSnapshot?.entries.map((entry, index) => (
              <View
                key={entry.uri}
                style={[styles.rowDivider, index === folderSnapshot.entries.length - 1 ? styles.rowDividerLast : null]}
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
        <View style={styles.modalOverlay}>
          <View style={styles.hostedModalCard}>
            <Pressable
              hitSlop={12}
              onPress={() => {
                if (sharingHostedFileId) {
                  return;
                }

                setShareTarget(null);
                setHostedPasscode("");
              }}
              style={({ pressed }) => [styles.modalCloseButton, pressed ? styles.pressed : null]}
            >
              <X color={designTheme.mutedForeground} size={18} strokeWidth={2.2} />
            </Pressable>

            <View style={styles.hostedModalContent}>
              <Text style={styles.hostedModalTitle}>Share hosted URL</Text>
              <Text style={styles.hostedModalDescription}>{shareTarget?.fileName ?? "Hosted file"}</Text>
              <Text style={styles.hostedModalHint}>
                Leave the passcode blank to remove any current protection before generating a fresh link.
              </Text>
              <TextInput
                keyboardType={"number-pad"}
                maxLength={6}
                onChangeText={setHostedPasscode}
                placeholder={
                  shareTarget?.requiresPasscode ? "Leave blank to remove current passcode" : "Optional 6-digit passcode"
                }
                placeholderTextColor={designTheme.mutedForeground}
                style={styles.hostedModalInput}
                value={hostedPasscode}
              />
              <View style={styles.hostedModalActions}>
                <Pressable
                  disabled={Boolean(sharingHostedFileId)}
                  onPress={() => {
                    setShareTarget(null);
                    setHostedPasscode("");
                  }}
                  style={({ pressed }) => [
                    styles.modalSecondaryButton,
                    sharingHostedFileId ? styles.disabled : null,
                    pressed ? styles.pressed : null,
                  ]}
                >
                  <Text style={styles.modalSecondaryButtonLabel}>Cancel</Text>
                </Pressable>
                <Pressable
                  disabled={Boolean(sharingHostedFileId)}
                  onPress={() => {
                    void handleShareHostedFile();
                  }}
                  style={({ pressed }) => [
                    styles.modalPrimaryButton,
                    sharingHostedFileId ? styles.disabled : null,
                    pressed ? styles.pressed : null,
                  ]}
                >
                  {sharingHostedFileId ? (
                    <ActivityIndicator color={designTheme.primaryForeground} size={"small"} />
                  ) : null}
                  <Text style={styles.modalPrimaryButtonLabel}>Share</Text>
                </Pressable>
              </View>
            </View>
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
  },
  summaryCard: {
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 24,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  summaryHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
  },
  summaryIconWrap: {
    alignItems: "center",
    backgroundColor: "rgba(37, 99, 235, 0.08)",
    borderRadius: 999,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  summaryCopy: {
    flex: 1,
    gap: 2,
  },
  summaryLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.medium,
    fontSize: 13,
    textTransform: "uppercase",
  },
  summaryValue: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 20,
  },
  summaryDescription: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  section: {
    gap: 12,
  },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  sectionHeaderCopy: {
    flex: 1,
  },
  sectionTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 18,
  },
  sectionDescription: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  refreshButton: {
    alignItems: "center",
    backgroundColor: "rgba(37, 99, 235, 0.08)",
    borderRadius: 999,
    flexDirection: "row",
    gap: 8,
    minHeight: 38,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  refreshButtonLabel: {
    color: designTheme.primary,
    fontFamily: designFonts.medium,
    fontSize: 13,
  },
  card: {
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 20,
    borderWidth: 1,
    overflow: "hidden",
  },
  emptyState: {
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 28,
  },
  emptyIconWrap: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 999,
    height: 60,
    justifyContent: "center",
    width: 60,
  },
  emptyTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 17,
  },
  emptyCopy: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  rowDivider: {
    borderBottomColor: designTheme.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowDividerLast: {
    borderBottomWidth: 0,
  },
  downloadRow: {
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  downloadRowHeader: {
    flexDirection: "row",
    gap: 12,
  },
  previewIconWrap: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 12,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  downloadCopy: {
    flex: 1,
    gap: 2,
  },
  downloadName: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  downloadMeta: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  hostedFileHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
  },
  hostedStatusBadge: {
    backgroundColor: "rgba(22, 163, 74, 0.1)",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  hostedStatusBadgeExpired: {
    backgroundColor: "rgba(217, 119, 6, 0.12)",
  },
  hostedStatusBadgePending: {
    backgroundColor: "rgba(15, 23, 42, 0.08)",
  },
  hostedStatusBadgeLabel: {
    color: designTheme.success,
    fontFamily: designFonts.semibold,
    fontSize: 11,
  },
  hostedStatusBadgeLabelExpired: {
    color: "#92400e",
  },
  hostedStatusBadgeLabelPending: {
    color: designTheme.mutedForeground,
  },
  downloadTime: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 12,
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
  },
  actionButton: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 42,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  actionButtonPrimary: {
    backgroundColor: designTheme.primary,
    borderColor: designTheme.primary,
  },
  actionButtonSecondary: {
    backgroundColor: "rgba(37, 99, 235, 0.08)",
    borderColor: "rgba(37, 99, 235, 0.14)",
  },
  actionButtonLabel: {
    fontFamily: designFonts.semibold,
    fontSize: 14,
  },
  actionButtonLabelPrimary: {
    color: designTheme.primaryForeground,
  },
  actionButtonLabelSecondary: {
    color: designTheme.primary,
  },
  hostedDeleteButton: {
    backgroundColor: "rgba(220, 38, 38, 0.08)",
    borderColor: "rgba(220, 38, 38, 0.12)",
  },
  hostedDeleteButtonLabel: {
    color: designTheme.destructive,
  },
  actionIconButton: {
    alignItems: "center",
    borderRadius: 999,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  actionIconButtonDanger: {
    backgroundColor: "rgba(220, 38, 38, 0.08)",
  },
  navigatorHeader: {
    gap: 12,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 14,
  },
  breadcrumbWrap: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  crumbButton: {
    backgroundColor: designTheme.muted,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  crumbLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 13,
  },
  upButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "rgba(37, 99, 235, 0.08)",
    borderRadius: 999,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  upButtonLabel: {
    color: designTheme.primary,
    fontFamily: designFonts.medium,
    fontSize: 13,
  },
  notice: {
    backgroundColor: designTheme.muted,
    borderRadius: 16,
    gap: 4,
    marginHorizontal: 18,
    marginBottom: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  noticeTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 14,
  },
  noticeCopy: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  loadingState: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 18,
    paddingBottom: 16,
  },
  loadingCopy: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
  },
  emptyBrowserState: {
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 18,
    paddingBottom: 22,
    paddingTop: 8,
  },
  emptyBrowserTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 17,
  },
  emptyBrowserCopy: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  browserRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  browserRowLead: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 12,
  },
  browserPressArea: {
    paddingVertical: 2,
  },
  browserCopy: {
    flex: 1,
    gap: 2,
  },
  browserName: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  browserMeta: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  browserActionRow: {
    flexDirection: "row",
    gap: 8,
  },
  browserShareButton: {
    alignItems: "center",
    backgroundColor: "rgba(37, 99, 235, 0.08)",
    borderRadius: 999,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  browserDeleteButton: {
    backgroundColor: "rgba(220, 38, 38, 0.08)",
  },
  modalOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(15, 23, 42, 0.28)",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  hostedModalCard: {
    backgroundColor: designTheme.background,
    borderColor: designTheme.border,
    borderRadius: 24,
    borderWidth: 1,
    maxWidth: 420,
    padding: 20,
    width: "100%",
  },
  modalCloseButton: {
    alignItems: "center",
    alignSelf: "flex-end",
    backgroundColor: designTheme.secondary,
    borderRadius: 999,
    height: 36,
    justifyContent: "center",
    marginBottom: 12,
    width: 36,
  },
  hostedModalContent: {
    gap: 14,
  },
  hostedModalTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 22,
  },
  hostedModalDescription: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
  },
  hostedModalHint: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  hostedModalInput: {
    backgroundColor: designTheme.secondary,
    borderColor: designTheme.border,
    borderRadius: 14,
    borderWidth: 1,
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 15,
    minHeight: 50,
    paddingHorizontal: 14,
  },
  hostedModalActions: {
    flexDirection: "row",
    gap: 10,
  },
  modalSecondaryButton: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 14,
    flex: 1,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 14,
  },
  modalSecondaryButtonLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 15,
  },
  modalPrimaryButton: {
    alignItems: "center",
    backgroundColor: designTheme.primary,
    borderRadius: 14,
    flex: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 14,
  },
  modalPrimaryButtonLabel: {
    color: designTheme.primaryForeground,
    fontFamily: designFonts.semibold,
    fontSize: 15,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.72,
  },
});
