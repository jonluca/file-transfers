import React from "react";
import { Text, View } from "react-native";

type NoticeTone = "default" | "success" | "warning" | "danger";

const noticeStyles: Record<NoticeTone, { background: string; border: string; title: string; body: string }> = {
  default: {
    background: "rgba(15, 23, 42, 0.04)",
    border: "rgba(15, 23, 42, 0.08)",
    title: "#0f172a",
    body: "#475569",
  },
  success: {
    background: "rgba(22, 163, 74, 0.08)",
    border: "rgba(22, 163, 74, 0.16)",
    title: "#166534",
    body: "#166534",
  },
  warning: {
    background: "rgba(217, 119, 6, 0.08)",
    border: "rgba(217, 119, 6, 0.16)",
    title: "#92400e",
    body: "#92400e",
  },
  danger: {
    background: "rgba(220, 38, 38, 0.08)",
    border: "rgba(220, 38, 38, 0.16)",
    title: "#991b1b",
    body: "#991b1b",
  },
};

interface InlineNoticeProps {
  title: string;
  description: string;
  tone?: NoticeTone;
}

export function InlineNotice({ title, description, tone = "default" }: InlineNoticeProps) {
  const styles = noticeStyles[tone];

  return (
    <View
      style={{
        borderRadius: 18,
        borderWidth: 1,
        borderColor: styles.border,
        backgroundColor: styles.background,
        padding: 14,
        gap: 6,
      }}
    >
      <Text selectable style={{ color: styles.title, fontSize: 15, fontWeight: "700" }}>
        {title}
      </Text>
      <Text selectable style={{ color: styles.body, fontSize: 14, lineHeight: 20 }}>
        {description}
      </Text>
    </View>
  );
}
