import * as Linking from "expo-linking";
import * as Sharing from "expo-sharing";
import { router } from "expo-router";
import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  ArrowDown,
  ArrowUp,
  File,
  FileText,
  Film,
  FolderOpen,
  ImageIcon,
  MoreVertical,
  Music,
  Share2,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { designFonts, designTheme } from "@/lib/design/theme";
import { formatBytes, type ReceivedFileRecord } from "@/lib/file-transfer";
import { useRecentTransfers } from "@/store";

function getFileIcon(type: string) {
  if (type.startsWith("image/")) {
    return ImageIcon;
  }

  if (type.startsWith("video/")) {
    return Film;
  }

  if (type.startsWith("audio/")) {
    return Music;
  }

  if (type.includes("pdf") || type.includes("document") || type.includes("text")) {
    return FileText;
  }

  return File;
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

async function handleOpenReceivedFile(file: ReceivedFileRecord | undefined) {
  if (!file) {
    return;
  }

  await Linking.openURL(file.uri);
}

async function handleShareReceivedFile(file: ReceivedFileRecord | undefined) {
  if (!file) {
    return;
  }

  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    return;
  }

  await Sharing.shareAsync(file.uri);
}

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const recentTransfers = useRecentTransfers();
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  if (recentTransfers.length === 0) {
    return (
      <View style={[styles.root, styles.emptyRoot, { paddingTop: insets.top }]}>
        <View style={styles.emptyIconWrap}>
          <File color={designTheme.mutedForeground} size={40} strokeWidth={1.7} />
        </View>
        <Text style={styles.emptyTitle}>No transfers yet</Text>
        <Text style={styles.emptyCopy}>Your sent and received files will appear here</Text>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 24) + 12 }}
      showsVerticalScrollIndicator={false}
      style={[styles.root, { paddingTop: insets.top + 16 }]}
      onScrollBeginDrag={() => setOpenMenuId(null)}
    >
      <Text style={styles.title}>Recent transfers</Text>

      <View style={styles.stack}>
        {recentTransfers.map((entry) => {
          const firstFile = entry.files[0];
          const Icon = getFileIcon(firstFile?.mimeType ?? "application/octet-stream");
          const fileLabel = entry.files.length === 1 ? entry.files[0].name : `${entry.fileCount} files`;

          return (
            <View key={entry.id} style={styles.card}>
              <View style={styles.iconWrap}>
                <View style={styles.mainIconBox}>
                  <Icon color={designTheme.secondaryForeground} size={24} strokeWidth={1.8} />
                </View>
                <View
                  style={[styles.directionBadge, entry.direction === "send" ? styles.sentBadge : styles.receivedBadge]}
                >
                  {entry.direction === "send" ? (
                    <ArrowUp color={designTheme.primaryForeground} size={12} strokeWidth={2.1} />
                  ) : (
                    <ArrowDown color={designTheme.accentForeground} size={12} strokeWidth={2.1} />
                  )}
                </View>
              </View>

              <View style={styles.copy}>
                <View style={styles.headlineRow}>
                  <Text numberOfLines={1} style={styles.deviceName}>
                    {entry.deviceName}
                  </Text>
                  {entry.status === "failed" ? <Text style={styles.failedPill}>Failed</Text> : null}
                  {entry.status === "paused" ? <Text style={styles.pausedPill}>Paused</Text> : null}
                </View>

                <Text numberOfLines={1} style={styles.fileLabel}>
                  {fileLabel}
                </Text>
                <Text style={styles.timeLabel}>
                  {formatBytes(entry.totalBytes)} · {formatRelativeTime(entry.updatedAt)}
                </Text>
              </View>

              {entry.direction === "receive" && entry.status === "completed" ? (
                <View style={styles.actionsWrap}>
                  <Pressable
                    onPress={() => setOpenMenuId((current) => (current === entry.id ? null : entry.id))}
                    hitSlop={12}
                    style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
                  >
                    <MoreVertical color={designTheme.foreground} size={18} strokeWidth={2} />
                  </Pressable>
                  {openMenuId === entry.id ? (
                    <View style={styles.actionMenu}>
                      <Pressable
                        onPress={() => {
                          setOpenMenuId(null);
                          void handleOpenReceivedFile(firstFile);
                        }}
                        style={({ pressed }) => [styles.actionMenuItem, pressed ? styles.pressed : null]}
                      >
                        <FolderOpen color={designTheme.foreground} size={16} strokeWidth={2} />
                        <Text style={styles.actionMenuLabel}>Open</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          setOpenMenuId(null);
                          void handleShareReceivedFile(firstFile);
                        }}
                        style={({ pressed }) => [styles.actionMenuItem, pressed ? styles.pressed : null]}
                      >
                        <Share2 color={designTheme.foreground} size={16} strokeWidth={2} />
                        <Text style={styles.actionMenuLabel}>Share</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {entry.status === "failed" ? (
                <Pressable
                  onPress={() => router.navigate("/")}
                  style={({ pressed }) => [styles.retryButton, pressed ? styles.pressed : null]}
                >
                  <Text style={styles.retryLabel}>Retry</Text>
                </Pressable>
              ) : null}

              {entry.status === "paused" ? (
                <Pressable
                  onPress={() => router.navigate("/")}
                  style={({ pressed }) => [styles.retryButton, pressed ? styles.pressed : null]}
                >
                  <Text style={styles.retryLabel}>Resume</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
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
    backgroundColor: designTheme.muted,
    borderRadius: 999,
    height: 80,
    justifyContent: "center",
    marginBottom: 24,
    width: 80,
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
    fontSize: 16,
    textAlign: "center",
  },
  title: {
    color: designTheme.foreground,
    fontFamily: designFonts.semibold,
    fontSize: 24,
    marginBottom: 16,
  },
  stack: {
    gap: 12,
  },
  card: {
    alignItems: "flex-start",
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 16,
    padding: 16,
    position: "relative",
  },
  iconWrap: {
    position: "relative",
  },
  mainIconBox: {
    alignItems: "center",
    backgroundColor: designTheme.secondary,
    borderRadius: 14,
    height: 48,
    justifyContent: "center",
    width: 48,
  },
  directionBadge: {
    alignItems: "center",
    borderRadius: 999,
    bottom: -4,
    height: 24,
    justifyContent: "center",
    position: "absolute",
    right: -4,
    width: 24,
  },
  sentBadge: {
    backgroundColor: designTheme.primary,
  },
  receivedBadge: {
    backgroundColor: designTheme.accent,
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  headlineRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 2,
  },
  deviceName: {
    color: designTheme.foreground,
    flexShrink: 1,
    fontFamily: designFonts.medium,
    fontSize: 16,
  },
  fileLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 14,
  },
  timeLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.regular,
    fontSize: 12,
    marginTop: 4,
  },
  failedPill: {
    backgroundColor: "rgba(220, 38, 38, 0.08)",
    borderRadius: 999,
    color: designTheme.destructive,
    fontFamily: designFonts.medium,
    fontSize: 12,
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pausedPill: {
    backgroundColor: designTheme.muted,
    borderRadius: 999,
    color: designTheme.mutedForeground,
    fontFamily: designFonts.medium,
    fontSize: 12,
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  iconButton: {
    alignItems: "center",
    borderRadius: 999,
    justifyContent: "center",
    minHeight: 32,
    minWidth: 32,
  },
  actionsWrap: {
    alignItems: "flex-end",
    position: "relative",
  },
  actionMenu: {
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 14,
    borderWidth: 1,
    gap: 4,
    padding: 6,
    position: "absolute",
    right: 0,
    top: 34,
    width: 120,
    zIndex: 10,
  },
  actionMenuItem: {
    alignItems: "center",
    borderRadius: 10,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  actionMenuLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 14,
  },
  retryButton: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: designTheme.card,
    borderColor: designTheme.border,
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 36,
    paddingHorizontal: 14,
  },
  retryLabel: {
    color: designTheme.foreground,
    fontFamily: designFonts.medium,
    fontSize: 14,
  },
  pressed: {
    opacity: 0.72,
  },
});
