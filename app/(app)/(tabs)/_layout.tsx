import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { usePathname } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import React, { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { queryClient } from "@/app/_layout";
import { useSession } from "@/lib/auth-client";

export default function TabLayout() {
  const pathname = usePathname();
  const isInitialMount = useRef(true);
  const { data: session } = useSession();
  const settingsLabel = session?.user ? "Account" : "Settings";

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    void queryClient.refetchQueries({ type: "active" });
  }, [pathname]);

  return (
    <NativeTabs minimizeBehavior={"onScrollDown"} tintColor={"#2563eb"} backgroundColor={"transparent"}>
      <NativeTabs.Trigger name={"index"}>
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        {Platform.select({
          ios: <NativeTabs.Trigger.Icon sf={{ default: "square.grid.2x2", selected: "square.grid.2x2.fill" }} />,
          android: (
            <NativeTabs.Trigger.Icon
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"dashboard"} />}
            />
          ),
        })}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name={"ui"}>
        <NativeTabs.Trigger.Label>UI</NativeTabs.Trigger.Label>
        {Platform.select({
          ios: <NativeTabs.Trigger.Icon sf={{ default: "slider.horizontal.3", selected: "slider.horizontal.3" }} />,
          android: (
            <NativeTabs.Trigger.Icon src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"tune"} />} />
          ),
        })}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name={"settings"}>
        <NativeTabs.Trigger.Label>{settingsLabel}</NativeTabs.Trigger.Label>
        {Platform.select({
          ios: (
            <NativeTabs.Trigger.Icon
              sf={
                session?.user
                  ? { default: "person.crop.circle", selected: "person.crop.circle.fill" }
                  : { default: "gearshape", selected: "gearshape.fill" }
              }
            />
          ),
          android: (
            <NativeTabs.Trigger.Icon
              src={
                <NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={session?.user ? "person" : "settings"} />
              }
            />
          ),
        })}
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
