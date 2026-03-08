import React from "react";
import { Platform } from "react-native";
import { NativeProfileEditor as AndroidNativeProfileEditor } from "./profile-editor.android";
import { NativeProfileEditor as IosNativeProfileEditor } from "./profile-editor.ios";
import type { NativeProfileEditorProps } from "./types";

export function NativeProfileEditor(props: NativeProfileEditorProps) {
  return Platform.OS === "android" ? <AndroidNativeProfileEditor {...props} /> : <IosNativeProfileEditor {...props} />;
}
