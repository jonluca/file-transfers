import React from "react";
import { Platform } from "react-native";
import { NativeUiShowcase as AndroidNativeUiShowcase } from "./ui-showcase.android";
import { NativeUiShowcase as IosNativeUiShowcase } from "./ui-showcase.ios";
import type { NativeUiShowcaseProps } from "./types";

export function NativeUiShowcase(props: NativeUiShowcaseProps) {
  return Platform.OS === "android" ? <AndroidNativeUiShowcase {...props} /> : <IosNativeUiShowcase {...props} />;
}
