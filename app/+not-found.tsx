import { Link, Stack } from "expo-router";
import React from "react";
import { Pressable, Text, View } from "react-native";

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Not Found" }} />
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          gap: 16,
          padding: 24,
          backgroundColor: "#f5f7fb",
        }}
      >
        <Text selectable style={{ fontSize: 28, fontWeight: "800", color: "#0f172a" }}>
          Missing Route
        </Text>
        <Text selectable style={{ textAlign: "center", fontSize: 16, lineHeight: 24, color: "#64748b" }}>
          This starter only wires the shell routes. Add your own screens or head back to the home tab.
        </Text>
        <Link href={"/"} asChild>
          <Pressable
            style={{
              borderRadius: 999,
              backgroundColor: "#2563eb",
              paddingHorizontal: 18,
              paddingVertical: 12,
            }}
          >
            <Text selectable style={{ color: "#ffffff", fontWeight: "700" }}>
              Go Home
            </Text>
          </Pressable>
        </Link>
      </View>
    </>
  );
}
