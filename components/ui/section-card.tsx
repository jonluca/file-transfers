import React from "react";
import { Text, View } from "react-native";

interface SectionCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

export function SectionCard({ title, description, children }: SectionCardProps) {
  return (
    <View
      style={{
        backgroundColor: "#ffffff",
        borderRadius: 28,
        padding: 18,
        gap: 14,
        borderWidth: 1,
        borderColor: "rgba(15, 23, 42, 0.08)",
        boxShadow: "0 18px 40px rgba(15, 23, 42, 0.06)",
      }}
    >
      <View style={{ gap: 6 }}>
        <Text selectable style={{ fontSize: 20, fontWeight: "700", color: "#0f172a" }}>
          {title}
        </Text>
        {description ? (
          <Text selectable style={{ fontSize: 14, lineHeight: 21, color: "#64748b" }}>
            {description}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}
