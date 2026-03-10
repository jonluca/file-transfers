import { router } from "expo-router";
import React from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
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
  shareReceivedFileAsync,
  type TransferHistoryEntry,
} from "@/lib/file-transfer";
import { getTabScreenTopInset } from "@/lib/design/tab-screen-insets";
import { useRecentTransfers } from "@/store";

const fontStyles = {
  regular: { fontFamily: designFonts.regular },
  medium: { fontFamily: designFonts.medium },
  semibold: { fontFamily: designFonts.semibold },
} as const;

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

  try {
    const didShare = await shareReceivedFileAsync(file);
    if (!didShare) {
      Alert.alert("Sharing unavailable", "This device does not support the system share sheet.");
    }
  } catch (error) {
    console.error("Unable to share received file", error);
    Alert.alert("Unable to share file", "Please try again in a moment.");
  }
}

function HistoryRow({ entry }: { entry: TransferHistoryEntry }) {
  const firstFile = entry.files[0];
  const DirectionIcon = entry.direction === "send" ? Upload : Download;
  const statusTone = getStatusTone(entry.status);
  const fileLabel =
    entry.fileCount === 0
      ? "No files on device"
      : entry.files.length === 1
        ? entry.files[0].name
        : `${entry.fileCount} files`;
  const summaryLabel =
    entry.direction === "receive" && entry.fileCount === 0
      ? "Received files deleted from this device"
      : `${entry.direction === "send" ? "Sent" : "Received"} ${fileLabel} • ${formatBytes(entry.totalBytes)}`;

  return (
    <View className={"gap-3 border-b border-[#e5e7eb] px-[18px] py-4"}>
      <View className={"flex-row items-start justify-between"}>
        <View className={"flex-1 flex-row gap-3.5"}>
          <View className={"mt-0.5 h-10 w-10 items-center justify-center rounded-full bg-[#f3f4f6]"}>
            <DirectionIcon color={designTheme.mutedForeground} size={18} strokeWidth={2} />
          </View>
          <View className={"flex-1 gap-0.5"}>
            <Text className={"text-base text-[#030213]"} numberOfLines={1} style={fontStyles.medium}>
              {entry.deviceName}
            </Text>
            <Text className={"text-sm leading-5 text-[#6b7280]"} numberOfLines={1} style={fontStyles.regular}>
              {summaryLabel}
            </Text>
            <Text className={"mt-0.5 text-xs text-[#6b7280]"} style={fontStyles.regular}>
              {formatRelativeTime(entry.updatedAt)}
            </Text>
          </View>
        </View>

        <View
          className={"ml-3 h-[26px] w-[26px] items-center justify-center rounded-full"}
          style={{ backgroundColor: statusTone.backgroundColor }}
        >
          {statusTone.icon}
        </View>
      </View>

      <View className={"flex-row items-center gap-2.5 rounded-[14px] bg-[#f9fafb] px-3 py-2.5"}>
        <View className={"h-8 w-8 items-center justify-center rounded-[10px] bg-white"}>
          <FilePreviewIcon type={firstFile?.mimeType ?? "application/octet-stream"} />
        </View>
        <Text className={"flex-1 text-sm text-[#030213]"} numberOfLines={1} style={fontStyles.medium}>
          {fileLabel}
        </Text>
      </View>

      {entry.direction === "receive" && entry.status === "completed" && firstFile ? (
        <View className={"flex-row gap-2.5"}>
          <Pressable
            className={
              "min-h-[42px] flex-1 flex-row items-center justify-center gap-2 rounded-full border border-[#2563eb] bg-[#2563eb] px-[14px] py-2.5"
            }
            onPress={() => {
              void handleOpenReceivedFile(firstFile);
            }}
            style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
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
            onPress={() => {
              void handleShareReceivedFile(firstFile);
            }}
            style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
          >
            <Share2 color={designTheme.primary} size={16} strokeWidth={2.2} />
            <Text className={"text-sm text-[#2563eb]"} style={fontStyles.semibold}>
              Share
            </Text>
          </Pressable>
        </View>
      ) : null}

      {entry.status === "failed" ? (
        <Pressable
          className={"self-start rounded-full bg-[#f3f4f6] px-3 py-2"}
          onPress={() => router.navigate("/")}
          style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
        >
          <Text className={"text-[13px] text-[#2563eb]"} style={fontStyles.medium}>
            Retry
          </Text>
        </Pressable>
      ) : null}

      {entry.status === "paused" ? (
        <Pressable
          className={"self-start rounded-full bg-[#f3f4f6] px-3 py-2"}
          onPress={() => router.navigate("/")}
          style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
        >
          <Text className={"text-[13px] text-[#2563eb]"} style={fontStyles.medium}>
            Resume
          </Text>
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
      <View className={"flex-1 items-center justify-center bg-white px-6 pb-6"} style={{ paddingTop: topInset }}>
        <View className={"mb-6 h-[88px] w-[88px] items-center justify-center rounded-full bg-[#f3f4f6]"}>
          <File color={designTheme.mutedForeground} size={36} strokeWidth={1.8} />
        </View>
        <Text className={"mb-2 text-2xl text-[#030213]"} style={fontStyles.semibold}>
          No transfers yet
        </Text>
        <Text className={"text-center text-[15px] leading-[22px] text-[#6b7280]"} style={fontStyles.regular}>
          Your sent and received files will appear here
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerClassName={"pb-10"}
      showsVerticalScrollIndicator={false}
      className={"flex-1 bg-white px-6"}
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 24) + 16 }}
      style={{ paddingTop: topInset + 16 }}
    >
      <Text className={"mb-4 text-2xl text-[#030213]"} style={fontStyles.semibold}>
        History
      </Text>
      <View className={"overflow-hidden rounded-[20px] border border-[#e5e7eb] bg-white"}>
        {recentTransfers.map((entry) => (
          <HistoryRow key={entry.id} entry={entry} />
        ))}
      </View>
    </ScrollView>
  );
}
