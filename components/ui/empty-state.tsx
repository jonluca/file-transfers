import React from "react";
import { Text, View } from "react-native";

interface EmptyStateProps {
  title: string;
  description: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <View
      style={{
        borderRadius: 24,
        borderWidth: 1,
        borderColor: "rgba(15, 23, 42, 0.08)",
        backgroundColor: "rgba(255, 255, 255, 0.78)",
        padding: 20,
        gap: 8,
      }}
    >
      <Text selectable style={{ fontSize: 18, fontWeight: "700", color: "#0f172a" }}>
        {title}
      </Text>
      <Text selectable style={{ fontSize: 14, lineHeight: 22, color: "#64748b" }}>
        {description}
      </Text>
    </View>
  );
}
