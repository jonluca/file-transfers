import { Stack } from "expo-router";
import React from "react";
import { Platform } from "react-native";

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerBackButtonDisplayMode: "minimal",
        headerShadowVisible: false,
        headerTransparent: Platform.OS === "ios",
        headerBlurEffect: Platform.OS === "ios" ? "systemMaterial" : undefined,
        headerStyle: {
          backgroundColor: Platform.OS === "ios" ? "rgba(245, 247, 251, 0.92)" : "#f5f7fb",
        },
        headerTintColor: "#2563eb",
        headerTitleStyle: {
          color: "#0f172a",
          fontWeight: "700",
        },
        contentStyle: {
          backgroundColor: "#f5f7fb",
        },
      }}
    >
      <Stack.Screen name={"(tabs)"} options={{ headerShown: false }} />
      <Stack.Screen name={"account"} options={{ title: "Edit Account" }} />
    </Stack>
  );
}
