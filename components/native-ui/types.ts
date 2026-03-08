import type { AccentTheme } from "@/lib/accent-theme";

export interface NativeUiShowcaseProps {
  accentTheme: AccentTheme;
  notes: string;
  alertsEnabled: boolean;
  betaEnabled: boolean;
  intensity: number;
  onAccentThemeChange: (value: AccentTheme) => void;
  onNotesChange: (value: string) => void;
  onAlertsEnabledChange: (value: boolean) => void;
  onBetaEnabledChange: (value: boolean) => void;
  onIntensityChange: (value: number) => void;
  onPrimaryAction: () => void;
  onSecondaryAction: () => void;
}

export interface NativeProfileEditorProps {
  formKey: string;
  displayName: string;
  bio: string;
  accentTheme: AccentTheme;
  emailUpdatesEnabled: boolean;
  isSaving: boolean;
  saveLabel: string;
  onDisplayNameChange: (value: string) => void;
  onBioChange: (value: string) => void;
  onAccentThemeChange: (value: AccentTheme) => void;
  onEmailUpdatesEnabledChange: (value: boolean) => void;
  onSubmit: () => void;
}
