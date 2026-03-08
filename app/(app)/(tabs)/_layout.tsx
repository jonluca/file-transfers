import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { usePathname } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import React, { useEffect, useRef } from "react";
import { View } from "react-native";
import { queryClient } from "@/app/_layout";
import { designMetrics, designTheme } from "@/lib/design/theme";

const screenContentStyle = {
  backgroundColor: designTheme.background,
} as const;

export default function TabLayout() {
  const pathname = usePathname();
  const isInitialMount = useRef(true);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    void queryClient.refetchQueries({ type: "active" });
  }, [pathname]);

  return (
    <View style={{ flex: 1, backgroundColor: designTheme.background }}>
      <View
        style={{
          flex: 1,
          alignSelf: "center",
          width: "100%",
          maxWidth: designMetrics.appMaxWidth,
          backgroundColor: designTheme.background,
        }}
      >
        <NativeTabs minimizeBehavior={"onScrollDown"} tintColor={designTheme.primary} backgroundColor={"transparent"}>
          <NativeTabs.Trigger name={"index"} disableAutomaticContentInsets contentStyle={screenContentStyle}>
            <NativeTabs.Trigger.Label>Transfer</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon
              sf={{ default: "arrow.up.arrow.down.circle", selected: "arrow.up.arrow.down.circle.fill" }}
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"swap-vert"} />}
            />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name={"history"} disableAutomaticContentInsets contentStyle={screenContentStyle}>
            <NativeTabs.Trigger.Label>History</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon
              sf={{ default: "clock", selected: "clock.fill" }}
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"history"} />}
            />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name={"settings"} disableAutomaticContentInsets contentStyle={screenContentStyle}>
            <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon
              sf={{ default: "gearshape", selected: "gearshape.fill" }}
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"settings"} />}
            />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name={"ui"} hidden disableAutomaticContentInsets contentStyle={screenContentStyle} />
        </NativeTabs>
      </View>
    </View>
  );
}
