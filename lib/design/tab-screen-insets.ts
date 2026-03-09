import { Platform } from "react-native";

export function getTabScreenTopInset(topInset: number) {
  return Platform.OS === "ios" ? 0 : topInset;
}
