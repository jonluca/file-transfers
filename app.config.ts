import type { ConfigContext, ExpoConfig } from "expo/config";

const VERSION = "1.0.0";

export default function getConfig({ config }: ConfigContext): ExpoConfig {
  return {
    ...config,
    name: "File Transfers",
    slug: "file-transfers",
    version: VERSION,
    icon: "./assets/icon.png",
    orientation: "portrait",
    scheme: "filetransfers",
    userInterfaceStyle: "light",
    ios: {
      ...config.ios,
      supportsTablet: false,
      usesAppleSignIn: true,
      bundleIdentifier: "com.jonluca.filetransfers",
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSCameraUsageDescription: "Scan a nearby device QR code to connect to a transfer.",
        NSLocalNetworkUsageDescription: "Discover nearby devices on your local WiFi so files can transfer directly.",
        NSBonjourServices: ["_filetransfer._tcp."],
      },
    },
    android: {
      ...config.android,
      package: "com.jonluca.filetransfers",
      predictiveBackGestureEnabled: false,
      permissions: [
        "android.permission.INTERNET",
        "android.permission.ACCESS_NETWORK_STATE",
        "android.permission.ACCESS_WIFI_STATE",
        "android.permission.CHANGE_WIFI_MULTICAST_STATE",
        "android.permission.CAMERA",
      ],
    },
    plugins: [
      ...(config.plugins ?? []),
      "expo-apple-authentication",
      "expo-router",
      "expo-web-browser",
      "expo-sqlite",
      "expo-document-picker",
      [
        "expo-camera",
        {
          cameraPermission: "Scan a nearby device QR code to join a transfer session.",
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      router: {},
      eas: {
        projectId: "1070ca5a-5d8a-48ee-a705-b039eccc579b",
      },
    },
  } satisfies ExpoConfig;
}
