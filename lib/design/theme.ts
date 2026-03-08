export const designTheme = {
  background: "#ffffff",
  foreground: "#030213",
  card: "#ffffff",
  cardForeground: "#030213",
  primary: "#2563eb",
  primaryForeground: "#ffffff",
  secondary: "#f3f4f6",
  secondaryForeground: "#4b5563",
  muted: "#f9fafb",
  mutedForeground: "#6b7280",
  accent: "#16a34a",
  accentForeground: "#ffffff",
  destructive: "#dc2626",
  success: "#16a34a",
  warning: "#d97706",
  border: "#e5e7eb",
  input: "#f3f4f6",
  shadow: "rgba(3, 2, 19, 0.06)",
  ring: "rgba(37, 99, 235, 0.18)",
} as const;

export const designFonts = {
  regular: "Geist_400Regular",
  medium: "Geist_500Medium",
  semibold: "Geist_600SemiBold",
  bold: "Geist_700Bold",
} as const;

export const designMetrics = {
  appMaxWidth: 430,
  radius: 14,
  radiusLarge: 18,
  radiusXLarge: 24,
} as const;
