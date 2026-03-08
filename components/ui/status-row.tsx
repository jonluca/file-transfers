import React from "react";
import { Text, View } from "react-native";

type Tone = "default" | "success" | "warning";

const toneStyles: Record<Tone, { dot: string; text: string; background: string }> = {
  default: {
    dot: "#64748b",
    text: "#334155",
    background: "rgba(148, 163, 184, 0.12)",
  },
  success: {
    dot: "#16a34a",
    text: "#166534",
    background: "rgba(22, 163, 74, 0.12)",
  },
  warning: {
    dot: "#d97706",
    text: "#92400e",
    background: "rgba(217, 119, 6, 0.12)",
  },
};

interface StatusRowProps {
  label: string;
  value: string;
  tone?: Tone;
}

export function StatusRow({ label, value, tone = "default" }: StatusRowProps) {
  const styles = toneStyles[tone];

  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <Text selectable style={{ flex: 1, fontSize: 15, color: "#334155" }}>
        {label}
      </Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor: styles.background,
          borderRadius: 999,
          paddingHorizontal: 12,
          paddingVertical: 7,
        }}
      >
        <View style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: styles.dot }} />
        <Text
          selectable
          style={{
            color: styles.text,
            fontSize: 13,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
          }}
        >
          {value}
        </Text>
      </View>
    </View>
  );
}
