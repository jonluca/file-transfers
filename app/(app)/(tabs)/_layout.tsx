import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { usePathname } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import React, { useEffect, useRef } from "react";
import { Platform, View } from "react-native";
import { queryClient } from "@/app/_layout";
import { designMetrics, designTheme } from "@/lib/design/theme";

const screenContentStyle = {
  backgroundColor: designTheme.background,
} as const;
const disableAutomaticContentInsets = Platform.OS === "ios";

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
        <NativeTabs
          minimizeBehavior={"onScrollDown"}
          tintColor={designTheme.primary}
          backgroundColor={designTheme.background}
        >
          <NativeTabs.Trigger
            name={"index"}
            contentStyle={screenContentStyle}
            disableAutomaticContentInsets={disableAutomaticContentInsets}
          >
            <NativeTabs.Trigger.Label>Transfer</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon
              sf={{ default: "arrow.up.arrow.down.circle", selected: "arrow.up.arrow.down.circle.fill" }}
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"swap-vert"} />}
            />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger
            name={"files"}
            contentStyle={screenContentStyle}
            disableAutomaticContentInsets={disableAutomaticContentInsets}
          >
            <NativeTabs.Trigger.Label>Files</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon
              sf={{ default: "folder", selected: "folder.fill" }}
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"folder"} />}
            />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger
            name={"history"}
            contentStyle={screenContentStyle}
            disableAutomaticContentInsets={disableAutomaticContentInsets}
          >
            <NativeTabs.Trigger.Label>History</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon
              sf={{ default: "clock", selected: "clock.fill" }}
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"history"} />}
            />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger
            name={"settings"}
            contentStyle={screenContentStyle}
            disableAutomaticContentInsets={disableAutomaticContentInsets}
          >
            <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon
              sf={{ default: "gearshape", selected: "gearshape.fill" }}
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"settings"} />}
            />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger
            name={"ui"}
            hidden
            contentStyle={screenContentStyle}
            disableAutomaticContentInsets={disableAutomaticContentInsets}
          />
        </NativeTabs>
      </View>
    </View>
  );
}
