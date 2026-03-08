import type { ConfigContext, ExpoConfig } from "expo/config";

const VERSION = "1.0.0";

export default function getConfig({ config }: ConfigContext): ExpoConfig {
  return {
    ...config,
    name: "Mobile Boilerplate",
    slug: "mobile-boilerplate",
    version: VERSION,
    orientation: "portrait",
    scheme: "mobileboilerplate",
    userInterfaceStyle: "automatic",
    ios: {
      ...config.ios,
      supportsTablet: false,
      usesAppleSignIn: true,
      bundleIdentifier: "com.example.mobileboilerplate",
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      ...config.android,
      package: "com.example.mobileboilerplate",
      predictiveBackGestureEnabled: false,
    },
    plugins: [...(config.plugins ?? []), "expo-apple-authentication", "expo-router", "expo-web-browser", "expo-sqlite"],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      router: {},
    },
  } satisfies ExpoConfig;
}
