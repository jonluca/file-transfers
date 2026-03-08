import React from "react";
import { ScrollView, Text, View } from "react-native";

interface ScreenShellProps {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

export function ScreenShell({ title, subtitle, children }: ScreenShellProps) {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior={"automatic"}
      contentContainerStyle={{
        padding: 20,
        gap: 18,
        backgroundColor: "#f5f7fb",
      }}
      style={{ flex: 1, backgroundColor: "#f5f7fb" }}
    >
      <View style={{ gap: 8 }}>
        <Text selectable style={{ fontSize: 34, fontWeight: "800", letterSpacing: -0.7, color: "#0f172a" }}>
          {title}
        </Text>
        <Text selectable style={{ fontSize: 16, lineHeight: 24, color: "#475569" }}>
          {subtitle}
        </Text>
      </View>
      {children}
    </ScrollView>
  );
}
