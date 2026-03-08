import { Stack } from "expo-router";
import React from "react";
import { Platform } from "react-native";
import { designTheme } from "@/lib/design/theme";

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerBackButtonDisplayMode: "minimal",
        headerShadowVisible: false,
        headerTransparent: Platform.OS === "ios",
        headerBlurEffect: Platform.OS === "ios" ? "systemMaterial" : undefined,
        headerStyle: {
          backgroundColor: Platform.OS === "ios" ? "rgba(250, 250, 250, 0.92)" : designTheme.background,
        },
        headerTintColor: designTheme.primary,
        headerTitleStyle: {
          color: designTheme.foreground,
          fontWeight: "700",
        },
        contentStyle: {
          backgroundColor: designTheme.background,
        },
      }}
    >
      <Stack.Screen name={"(tabs)"} options={{ headerShown: false }} />
    </Stack>
  );
}
