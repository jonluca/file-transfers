import { Platform } from "react-native";

const ANDROID_NATIVE_TAB_BAR_HEIGHT = 80;
const DEFAULT_MIN_BOTTOM_INSET = 24;

export function getTabScreenTopInset(topInset: number) {
  return Platform.OS === "ios" ? 0 : topInset;
}

export function getTabScreenBottomPadding(bottomInset: number, extraPadding = 16) {
  const minimumBottomInset = Platform.OS === "android" ? ANDROID_NATIVE_TAB_BAR_HEIGHT : DEFAULT_MIN_BOTTOM_INSET;

  return Math.max(bottomInset, minimumBottomInset) + extraPadding;
}
