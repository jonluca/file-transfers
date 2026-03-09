import * as Sharing from "expo-sharing";
import { router } from "expo-router";
import React from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  Check,
  Download,
  File,
  FileText,
  Film,
  FolderOpen,
  ImageIcon,
  Music,
  Pause,
  Share2,
  Upload,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { designFonts, designTheme } from "@/lib/design/theme";
import {
  formatBytes,
  openReceivedFileAsync,
  type ReceivedFileRecord,
  type TransferHistoryEntry,
} from "@/lib/file-transfer";
import { getTabScreenTopInset } from "@/lib/design/tab-screen-insets";
import { useRecentTransfers } from "@/store";

function FilePreviewIcon({ type }: { type: string }) {
  if (type.startsWith("image/")) {
    return <ImageIcon color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />;
  }

  if (type.startsWith("video/")) {
    return <Film color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />;
  }

  if (type.startsWith("audio/")) {
    return <Music color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />;
  }

  if (type.includes("pdf") || type.includes("document") || type.includes("text")) {
    return <FileText color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />;
  }

  return <File color={designTheme.secondaryForeground} size={18} strokeWidth={1.9} />;
}

function formatRelativeTime(dateValue: string) {
  const date = new Date(dateValue);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
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

function getStatusTone(status: TransferHistoryEntry["status"]) {
  switch (status) {
    case "completed":
      return {
        backgroundColor: "rgba(22, 163, 74, 0.12)",
        color: designTheme.success,
        icon: <Check color={designTheme.success} size={14} strokeWidth={2.4} />,
      };
    case "failed":
      return {
        backgroundColor: "rgba(220, 38, 38, 0.12)",
        color: designTheme.destructive,
        icon: <X color={designTheme.destructive} size={14} strokeWidth={2.4} />,
      };
    case "paused":
      return {
        backgroundColor: "rgba(217, 119, 6, 0.14)",
        color: designTheme.warning,
        icon: <Pause color={designTheme.warning} size={14} strokeWidth={2.4} />,
      };
    default:
      return {
        backgroundColor: designTheme.secondary,
        color: designTheme.mutedForeground,
        icon: <File color={designTheme.mutedForeground} size={14} strokeWidth={2.2} />,
      };
  }
}

async function handleOpenReceivedFile(file: ReceivedFileRecord | undefined) {
  if (!file) {
    return;
  }

  try {
    await openReceivedFileAsync(file);
  } catch (error) {
    console.error("Unable to open received file", error);
    Alert.alert("Unable to open file", "Try sharing it to another app instead.");
  }
}

async function handleShareReceivedFile(file: ReceivedFileRecord | undefined) {
  if (!file) {
    return;
  }

  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    return;
  }

  try {
    await Sharing.shareAsync(file.uri);
  } catch (error) {
    console.error("Unable to share received file", error);
    Alert.alert("Unable to share file", "Please try again in a moment.");
  }
}

function HistoryRow({ entry }: { entry: TransferHistoryEntry }) {
  const firstFile = entry.files[0];
  const DirectionIcon = entry.direction === "send" ? Upload : Download;
  const statusTone = getStatusTone(entry.status);
  const fileLabel = entry.files.length === 1 ? entry.files[0].name : `${entry.fileCount} files`;
  const summaryLabel = `${entry.direction === "send" ? "Sent" : "Received"} ${fileLabel} • ${formatBytes(entry.totalBytes)}`;

  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <View style={styles.rowLead}>
          <View style={styles.iconWell}>
            <DirectionIcon color={designTheme.mutedForeground} size={18} strokeWidth={2} />
          </View>
          <View style={styles.copy}>
            <Text numberOfLines={1} style={styles.deviceName}>
              {entry.deviceName}
            </Text>
            <Text numberOfLines={1} style={styles.fileLabel}>
              {summaryLabel}
            </Text>
            <Text style={styles.timeLabel}>{formatRelativeTime(entry.updatedAt)}</Text>
          </View>
        </View>

        <View style={[styles.statusIconWrap, { backgroundColor: statusTone.backgroundColor }]}>{statusTone.icon}</View>
      </View>

      <View style={styles.filePreviewRow}>
        <View style={styles.filePreviewIcon}>
          <FilePreviewIcon type={firstFile?.mimeType ?? "application/octet-stream"} />
        </View>
        <Text numberOfLines={1} style={styles.filePreviewLabel}>
          {fileLabel}
        </Text>
      </View>

      {entry.direction === "receive" && entry.status === "completed" ? (
        <View style={styles.actionRow}>
          <Pressable
            onPress={() => {
              void handleOpenReceivedFile(firstFile);
            }}
            style={({ pressed }) => [styles.actionButton, styles.actionButtonPrimary, pressed ? styles.pressed : null]}
          >
            <FolderOpen color={designTheme.primaryForeground} size={16} strokeWidth={2.2} />
            <Text style={[styles.actionButtonLabel, styles.actionButtonLabelPrimary]}>Open</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              void handleShareReceivedFile(firstFile);
            }}
            style={({ pressed }) => [
              styles.actionButton,
              styles.actionButtonSecondary,
              pressed ? styles.pressed : null,
            ]}
          >
            <Share2 color={designTheme.primary} size={16} strokeWidth={2.2} />
            <Text style={[styles.actionButtonLabel, styles.actionButtonLabelSecondary]}>Share</Text>
          </Pressable>
        </View>
      ) : null}

      {entry.status === "failed" ? (
        <Pressable
          onPress={() => router.navigate("/")}
          style={({ pressed }) => [styles.rowButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.rowButtonLabel}>Retry</Text>
        </Pressable>
      ) : null}

      {entry.status === "paused" ? (
        <Pressable
          onPress={() => router.navigate("/")}
          style={({ pressed }) => [styles.rowButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.rowButtonLabel}>Resume</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const topInset = getTabScreenTopInset(insets.top);
  const recentTransfers = useRecentTransfers();

  if (recentTransfers.length === 0) {
    return (
      <View style={[styles.root, styles.emptyRoot, { paddingTop: topInset }]}>
        <View style={styles.emptyIconWrap}>
          <File color={designTheme.mutedForeground} size={36} strokeWidth={1.8} />
        </View>
        <Text style={styles.emptyTitle}>No transfers yet</Text>
        <Text style={styles.emptyCopy}>Your sent and received files will appear here</Text>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 24) + 16 }}
      showsVerticalScrollIndicator={false}
      style={[styles.root, { paddingTop: topInset + 16 }]}
    >
      <Text style={styles.title}>History</Text>
      <View style={styles.list}>
        {recentTransfers.map((entry) => (
          <HistoryRow key={entry.id} entry={entry} />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: designTheme.background,
    flex: 1,
    paddingHorizontal: 24,
  },
  emptyRoot: {
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 24,
  },
  emptyIconWrap: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 999,
    height: 88,
    justifyContent: "center",
    marginBottom: 24,
    width: 88,
  },
  emptyTitle: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 24,
    marginBottom: 8,
  },
  emptyCopy: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
  },
  title: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 24,
    marginBottom: 16,
  },
  list: {
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 20,
    borderWidth: 1,
    overflow: "hidden",
  },
  row: {
    borderBottomColor: designTheme.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  rowHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  rowLead: {
    flex: 1,
    flexDirection: "row",
    gap: 14,
  },
  iconWell: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 999,
    height: 40,
    justifyContent: "center",
    marginTop: 2,
    width: 40,
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  deviceName: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 16,
  },
  fileLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  timeLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 12,
    marginTop: 2,
  },
  statusIconWrap: {
    alignItems: "center",
    borderRadius: 999,
    height: 26,
    justifyContent: "center",
    marginLeft: 12,
    width: 26,
  },
  filePreviewRow: {
    alignItems: "center",
    backgroundColor: designTheme.muted,
    borderRadius: 14,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  filePreviewIcon: {
    alignItems: "center",
    backgroundColor: designTheme.card,
    borderRadius: 10,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  filePreviewLabel: {
    color: designTheme.foreground,
    flex: 1,
    fontFamily: designFonts.medium,
    fontSize: 14,
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
  rowButton: {
    alignSelf: "flex-start",
    backgroundColor: designTheme.secondary,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  rowButtonLabel: {
    color: designTheme.primary,
    fontFamily: designFonts.medium,
    fontSize: 13,
  },
  pressed: {
    opacity: 0.72,
  },
});
