import React from "react";
import { ActivityIndicator, Text, View } from "react-native";

export function FullScreenLoader({ label }: { label: string }) {
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#f5f7fb",
        padding: 24,
      }}
    >
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: 24,
          backgroundColor: "#ffffff",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 18px 40px rgba(15, 23, 42, 0.08)",
          marginBottom: 16,
        }}
      >
        <ActivityIndicator size={"large"} color={"#2563eb"} />
      </View>
      <Text selectable style={{ fontSize: 17, fontWeight: "600", color: "#0f172a" }}>
        {label}
      </Text>
    </View>
  );
}
