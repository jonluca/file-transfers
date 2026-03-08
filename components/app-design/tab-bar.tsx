import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ArrowUpDown, Clock3, Settings } from "lucide-react-native";
import { designFonts, designTheme } from "@/lib/design/theme";

const tabIcons = {
  index: ArrowUpDown,
  history: Clock3,
  settings: Settings,
} as const;

export function AppTabBar({ state, descriptors, insets, navigation }: BottomTabBarProps) {
  return (
    <View
      style={[
        styles.outer,
        {
          paddingBottom: Math.max(insets.bottom, 8),
        },
      ]}
    >
      <View style={styles.inner}>
        {state.routes.map((route, index) => {
          const descriptor = descriptors[route.key];
          const options = descriptor.options;
          const label =
            typeof options.tabBarLabel === "string"
              ? options.tabBarLabel
              : typeof options.title === "string"
                ? options.title
                : route.name;
          const isFocused = state.index === index;
          const Icon = tabIcons[route.name as keyof typeof tabIcons] ?? Settings;

          return (
            <Pressable
              key={route.key}
              accessibilityRole={"tab"}
              accessibilityState={isFocused ? { selected: true } : {}}
              onPress={() => {
                navigation.navigate(route.name);
              }}
              style={({ pressed }) => [styles.tabButton, pressed ? styles.tabButtonPressed : null]}
            >
              <Icon color={isFocused ? designTheme.primary : designTheme.mutedForeground} size={24} strokeWidth={1.9} />
              <Text style={[styles.tabLabel, isFocused ? styles.tabLabelActive : null]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: designTheme.border,
    backgroundColor: designTheme.card,
    paddingTop: 8,
  },
  inner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
  },
  tabButton: {
    alignItems: "center",
    borderRadius: 16,
    gap: 4,
    paddingHorizontal: 24,
    paddingVertical: 8,
  },
  tabButtonPressed: {
    opacity: 0.72,
  },
  tabLabel: {
    color: designTheme.mutedForeground,
    fontFamily: designFonts.medium,
    fontSize: 12,
  },
  tabLabelActive: {
    color: designTheme.primary,
  },
});
