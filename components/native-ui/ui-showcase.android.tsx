import React from "react";
import { Button, Column, Divider, Host, Picker, Slider, Switch, Text, TextInput } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, padding, paddingAll } from "@expo/ui/jetpack-compose/modifiers";
import { ACCENT_OPTIONS } from "@/lib/accent-theme";
import type { NativeUiShowcaseProps } from "@/components/native-ui/types";

export function NativeUiShowcase({
  accentTheme,
  notes,
  alertsEnabled,
  betaEnabled,
  intensity,
  onAccentThemeChange,
  onNotesChange,
  onAlertsEnabledChange,
  onBetaEnabledChange,
  onIntensityChange,
  onPrimaryAction,
  onSecondaryAction,
}: NativeUiShowcaseProps) {
  const selectedIndex = ACCENT_OPTIONS.findIndex((option) => option.value === accentTheme);

  return (
    <Host
      matchContents={{ vertical: true }}
      style={{
        width: "100%",
        minHeight: 520,
        borderRadius: 26,
        overflow: "hidden",
      }}
    >
      <Column modifiers={[fillMaxWidth(), paddingAll(18)]} verticalArrangement={{ spacedBy: 16 }}>
        <Text style={{ typography: "titleLarge", fontWeight: "700" }}>Buttons</Text>
        <Button variant={"elevated"} onPress={onPrimaryAction}>
          Run Primary Action
        </Button>
        <Button variant={"outlined"} onPress={onSecondaryAction}>
          Open Secondary Flow
        </Button>

        <Divider />

        <Text style={{ typography: "titleLarge", fontWeight: "700" }}>Inputs</Text>
        <Text style={{ typography: "labelLarge" }}>Notes</Text>
        <TextInput
          defaultValue={notes}
          multiline
          numberOfLines={4}
          onChangeText={onNotesChange}
          modifiers={[fillMaxWidth()]}
        />

        <Divider />

        <Text style={{ typography: "titleLarge", fontWeight: "700" }}>Controls</Text>
        <Switch value={alertsEnabled} label={"Release alerts"} onValueChange={onAlertsEnabledChange} />
        <Switch value={betaEnabled} label={"Experimental surfaces"} onValueChange={onBetaEnabledChange} />
        <Text style={{ typography: "labelLarge" }}>Confidence Threshold: {Math.round(intensity)}%</Text>
        <Slider value={intensity} min={0} max={100} steps={100} onValueChange={onIntensityChange} />

        <Text style={{ typography: "labelLarge" }}>Accent Theme</Text>
        <Picker
          options={ACCENT_OPTIONS.map((option) => option.label)}
          selectedIndex={selectedIndex}
          variant={"segmented"}
          onOptionSelected={({ nativeEvent }) => {
            const selectedOption = ACCENT_OPTIONS[nativeEvent.index];
            if (selectedOption) {
              onAccentThemeChange(selectedOption.value);
            }
          }}
          modifiers={[fillMaxWidth(), padding(0, 2, 0, 0)]}
        />
      </Column>
    </Host>
  );
}
