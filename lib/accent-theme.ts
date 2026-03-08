export const ACCENT_OPTIONS = [
  { value: "blue", label: "Ocean" },
  { value: "green", label: "Forest" },
  { value: "amber", label: "Sunset" },
  { value: "pink", label: "Signal" },
] as const;

export type AccentTheme = (typeof ACCENT_OPTIONS)[number]["value"];

export const ACCENT_COLORS: Record<AccentTheme, string> = {
  blue: "#2563eb",
  green: "#16a34a",
  amber: "#d97706",
  pink: "#db2777",
};

export function isAccentTheme(value: string): value is AccentTheme {
  return ACCENT_OPTIONS.some((option) => option.value === value);
}
