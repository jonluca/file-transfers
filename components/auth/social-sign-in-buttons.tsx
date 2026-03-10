import * as AppleAuthentication from "expo-apple-authentication";
import React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Apple } from "lucide-react-native";
import Svg, { Path } from "react-native-svg";

type AppleButtonType = "continue" | "signIn";

const APPLE_BUTTON_HEIGHT = 50;
const APPLE_BUTTON_RADIUS = 16;
const GOOGLE_BUTTON_HEIGHT = 48;

function getAppleNativeButtonType(type: AppleButtonType) {
  return type === "continue"
    ? AppleAuthentication.AppleAuthenticationButtonType.CONTINUE
    : AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN;
}

function getAppleFallbackLabel(type: AppleButtonType) {
  return type === "continue" ? "Continue with Apple" : "Sign in with Apple";
}

function GoogleMark() {
  return (
    <Svg fill={"none"} height={18} viewBox={"0 0 48 48"} width={18}>
      <Path
        d={
          "M43.611 20.083H42V20H24v8h11.303C33.654 32.657 29.249 36 24 36c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.959 3.041l5.657-5.657C34.047 6.054 29.277 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917Z"
        }
        fill={"#FFC107"}
      />
      <Path
        d={
          "M6.306 14.691 12.88 19.51A11.958 11.958 0 0 1 24 12c3.059 0 5.842 1.154 7.959 3.041l5.657-5.657C34.047 6.054 29.277 4 24 4c-7.682 0-14.347 4.337-17.694 10.691Z"
        }
        fill={"#FF3D00"}
      />
      <Path
        d={
          "M24 44c5.175 0 9.861-1.977 13.409-5.192l-6.19-5.238A11.933 11.933 0 0 1 24 36c-5.228 0-9.62-3.317-11.283-7.946l-6.525 5.026C9.5 39.556 16.227 44 24 44Z"
        }
        fill={"#4CAF50"}
      />
      <Path
        d={
          "M43.611 20.083H42V20H24v8h11.303a12.042 12.042 0 0 1-4.084 5.57l.003-.002 6.19 5.238C37.026 39.156 44 34 44 24c0-1.341-.138-2.65-.389-3.917Z"
        }
        fill={"#1976D2"}
      />
    </Svg>
  );
}

export function ContinueWithAppleButton({
  disabled = false,
  onPress,
  type = "continue",
}: {
  disabled?: boolean;
  onPress: () => void;
  type?: AppleButtonType;
}) {
  if (Platform.OS === "ios") {
    return (
      <View pointerEvents={disabled ? "none" : "auto"} style={[styles.fullWidth, disabled ? styles.disabled : null]}>
        <AppleAuthentication.AppleAuthenticationButton
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          buttonType={getAppleNativeButtonType(type)}
          cornerRadius={APPLE_BUTTON_RADIUS}
          onPress={onPress}
          style={styles.appleNativeButton}
        />
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole={"button"}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.appleFallbackButton,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Apple color={"#ffffff"} size={18} strokeWidth={2} />
      <Text style={styles.appleFallbackLabel}>{getAppleFallbackLabel(type)}</Text>
    </Pressable>
  );
}

export function ContinueWithGoogleButton({
  disabled = false,
  label = "Continue with Google",
  onPress,
}: {
  disabled?: boolean;
  label?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={"button"}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.googleButton,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <View style={styles.googleIconWrap}>
        <GoogleMark />
      </View>
      <Text style={styles.googleLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fullWidth: {
    width: "100%",
  },
  appleNativeButton: {
    height: APPLE_BUTTON_HEIGHT,
    width: "100%",
  },
  appleFallbackButton: {
    alignItems: "center",
    backgroundColor: "#000000",
    borderRadius: APPLE_BUTTON_RADIUS,
    flexDirection: "row",
    gap: 10,
    height: APPLE_BUTTON_HEIGHT,
    justifyContent: "center",
    width: "100%",
  },
  appleFallbackLabel: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
  googleButton: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#dadce0",
    borderRadius: 999,
    borderWidth: 1,
    height: GOOGLE_BUTTON_HEIGHT,
    justifyContent: "center",
    position: "relative",
    width: "100%",
  },
  googleIconWrap: {
    alignItems: "center",
    height: 18,
    justifyContent: "center",
    left: 16,
    position: "absolute",
    width: 18,
  },
  googleLabel: {
    color: "#1f1f1f",
    fontSize: 16,
    fontWeight: "500",
    letterSpacing: 0.1,
  },
  disabled: {
    opacity: 0.6,
  },
  pressed: {
    opacity: 0.86,
  },
});
