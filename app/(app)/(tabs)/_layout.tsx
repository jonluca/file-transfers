import { Tabs, usePathname } from "expo-router";
import React, { useEffect, useRef } from "react";
import { View } from "react-native";
import { queryClient } from "@/app/_layout";
import { AppTabBar } from "@/components/app-design/tab-bar";
import { designMetrics, designTheme } from "@/lib/design/theme";

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
        <Tabs
          tabBar={(props) => <AppTabBar {...props} />}
          screenOptions={{
            headerShown: false,
            sceneStyle: {
              backgroundColor: designTheme.background,
            },
          }}
        >
          <Tabs.Screen name={"index"} options={{ title: "Transfer" }} />
          <Tabs.Screen name={"history"} options={{ title: "History" }} />
          <Tabs.Screen name={"settings"} options={{ title: "Settings" }} />
          <Tabs.Screen name={"ui"} options={{ href: null }} />
        </Tabs>
      </View>
    </View>
  );
}
