export const designTheme = {
  background: "#fafafa",
  foreground: "#171717",
  card: "#ffffff",
  cardForeground: "#171717",
  primary: "#4f46e5",
  primaryForeground: "#ffffff",
  secondary: "#f2f1ff",
  secondaryForeground: "#4338ca",
  muted: "#f5f5f5",
  mutedForeground: "#737373",
  accent: "#22c55e",
  accentForeground: "#ffffff",
  destructive: "#dc2626",
  border: "#e5e7eb",
  input: "#f5f5f5",
  shadow: "rgba(15, 23, 42, 0.12)",
  ring: "rgba(79, 70, 229, 0.16)",
} as const;

export const designFonts = {
  regular: "Geist_400Regular",
  medium: "Geist_500Medium",
  semibold: "Geist_600SemiBold",
  bold: "Geist_700Bold",
} as const;

export const designMetrics = {
  appMaxWidth: 430,
  radius: 16,
  radiusLarge: 24,
  radiusXLarge: 28,
} as const;
